import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { defineAddon } from '../src/index.js';
import { serve, toNodeHandler } from '../src/node.js';
import { manifest } from './helpers.js';

const addon = defineAddon({
  manifest: manifest({
    resources: ['stream', 'watch_state'],
    watchState: { version: 2, push: {} },
  }),
  stream: async ({ request }) => ({
    streams: [{ url: new URL('/play.mkv', request.url).href }],
  }),
  watchState: { push: async () => {} },
});

test('behind a proxy, request.url carries the address users reached', async () => {
  const { server, url } = await serve(addon, { port: 0 });
  try {
    const res = await fetch(`${url}/stream/movie/tt1.json`, {
      headers: {
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'addon.example.com',
      },
    });
    assert.deepEqual(await res.json(), {
      streams: [{ url: 'https://addon.example.com/play.mkv' }],
    });

    const head = await fetch(`${url}/manifest.json`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  } finally {
    server.close();
  }
});

test('as middleware, other paths go to the next handler and oversized bodies stop early', async () => {
  const handler = toNodeHandler(addon);
  const server = createServer((req, res) =>
    handler(req, res, () => res.writeHead(200).end('next'))
  );
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    assert.equal(
      await (await fetch(`http://localhost:${port}/health`)).text(),
      'next'
    );

    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { port, method: 'POST', path: '/watch_state/push/movie/tt1.json' },
        (res) => resolve(res.statusCode ?? 0)
      );
      req.on('error', reject);
      req.end(Buffer.alloc(2 * 1024 * 1024, 'x'));
    });
    assert.equal(status, 413);
  } finally {
    server.close();
  }
});
