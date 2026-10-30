import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { z } from 'zod';
import { AddonError, defineAddon } from '../src/index.js';
import { BASE, call, collectLogs, manifest } from './helpers.js';

describe('routing', () => {
  test('ids and extras arrive decoded once, so encoded separators stay inside their value', async () => {
    let seen: unknown;
    const addon = defineAddon({
      manifest: manifest({
        resources: ['catalog', 'stream'],
        catalogs: [
          {
            type: 'movie',
            id: 'top',
            name: 'Top',
            extra: [{ name: 'search' }, { name: 'skip' }],
          },
        ],
      }),
      stream: async ({ id }) => {
        seen = id;
        return { streams: [] };
      },
      catalog: async ({ extra }) => {
        seen = extra;
        return { metas: [] };
      },
    });

    await call(addon, '/stream/series/tt0903747%3A1%3A1.json');
    assert.equal(seen, 'tt0903747:1:1');

    await call(
      addon,
      '/catalog/movie/top/search=tom%20%26%20jerry&skip=100.json'
    );
    assert.deepEqual(seen, { search: 'tom & jerry', skip: 100 });
  });

  test('paths outside the protocol fall through, so the addon can share a server', async () => {
    const addon = defineAddon({
      manifest: manifest(),
      config: z.object({ key: z.string().default('x') }),
      stream: async () => ({ streams: [] }),
    });
    for (const path of [
      '/health',
      '/api/v1/users',
      '/stream/movie/tt1',
      '/stream/movie.json',
    ]) {
      assert.equal(
        await addon.handle(new Request(`${BASE}${path}`)),
        null,
        path
      );
    }
  });

  test('the root leads to the configure page, which an addon without settings has too', async () => {
    const plain = defineAddon({
      manifest: manifest(),
      stream: async () => ({ streams: [] }),
    });
    const res = await call(plain, '/');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/configure');
    assert.equal((await call(plain, '/configure')).status, 200);
    const made = await call(plain, '/configure', {
      method: 'POST',
      body: JSON.stringify({ values: {} }),
    });
    assert.equal((await made.json()).manifestUrl, `${BASE}/manifest.json`);

    const pageless = defineAddon({
      manifest: manifest(),
      stream: async () => ({ streams: [] }),
      configure: false,
    });
    assert.equal(await pageless.handle(new Request(`${BASE}/`)), null);
  });

  test('a leading segment is a configuration only when the addon has one', async () => {
    const addon = defineAddon({
      manifest: manifest(),
      stream: async () => ({ streams: [] }),
    });
    assert.equal(
      await addon.handle(new Request(`${BASE}/abc/stream/movie/tt1.json`)),
      null
    );
    assert.equal((await call(addon, '/stream/movie/tt1.json')).status, 200);
  });

  test('served under a base path, links and the redirect keep it whether or not the router stripped it', async () => {
    const addon = defineAddon({
      manifest: manifest(),
      config: z.object({ key: z.string().default('x') }),
      stream: async () => ({ streams: [] }),
    });
    const at = (path: string, basePath: string, init?: RequestInit) =>
      addon.handle(new Request(`${BASE}${path}`, init), { basePath });
    const make = { method: 'POST', body: JSON.stringify({ values: {} }) };

    for (const [path, basePath] of [
      ['/addon', '/addon'],
      ['', '/addon/'],
    ]) {
      const root = await at(`${path}/`, basePath);
      assert.equal(root?.headers.get('location'), '/addon/configure');
      const made = await (await at(
        `${path}/configure`,
        basePath,
        make
      ))!.json();
      assert.match(
        made.manifestUrl,
        /^http:\/\/addon\.test\/addon\/[\w-]+\/manifest\.json$/
      );
      const segment = new URL(made.manifestUrl).pathname.split('/')[2];
      assert.equal(
        (await at(`${path}/${segment}/stream/movie/tt1.json`, basePath))
          ?.status,
        200
      );
    }

    const away = await at('/', '//elsewhere.example');
    assert.equal(away?.headers.get('location'), '/elsewhere.example/configure');
  });

  test('every answer, errors included, can be read cross-origin', async () => {
    const addon = defineAddon({
      manifest: manifest(),
      stream: async () => {
        throw new AddonError(429, 'Slow down', { retryAfter: 30 });
      },
    });
    const res = await call(addon, '/stream/movie/tt1.json');
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), '30');
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(await res.json(), { error: 'Slow down' });

    const preflight = await call(addon, '/stream/movie/tt1.json', {
      method: 'OPTIONS',
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
  });
});

describe('responses', () => {
  test('cache hints become Cache-Control and leave the body', async () => {
    const addon = defineAddon({
      manifest: manifest(),
      stream: async () => ({
        streams: [],
        cacheMaxAge: 3600,
        staleError: 86400,
      }),
    });
    const res = await call(addon, '/stream/movie/tt1.json');
    assert.equal(
      res.headers.get('cache-control'),
      'max-age=3600, stale-if-error=86400, public'
    );
    assert.deepEqual(await res.json(), { streams: [] });
  });

  test('a meta handler answering null is a 404, and a redirect is followed', async () => {
    const addon = defineAddon({
      manifest: manifest({ resources: ['meta', 'stream'] }),
      meta: async () => null,
      stream: async () => ({
        redirect: 'https://elsewhere.example/stream/movie/tt1.json',
      }),
    });
    assert.equal((await call(addon, '/meta/movie/tt1.json')).status, 404);
    const res = await call(addon, '/stream/movie/tt1.json');
    assert.equal(res.status, 307);
    assert.equal(
      res.headers.get('location'),
      'https://elsewhere.example/stream/movie/tt1.json'
    );
  });

  test('a response clients would reject is reported once, still sent, or refused in strict mode', async () => {
    const logs = collectLogs();
    const definition = {
      manifest: manifest({ resources: ['meta'] }),
      meta: async ({ id }: { id: string }) => ({
        meta: { id, type: 'movie', name: 'Film', released: '2010-07-16' },
      }),
    };

    const warned = defineAddon(definition);
    for (let i = 0; i < 3; i++) {
      assert.equal((await call(warned, '/meta/movie/tt1.json')).status, 200);
    }
    const warnings = logs.filter((entry) => entry.level === 'warn');
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0].fields.issues), /meta\.released/);

    const strict = defineAddon({ ...definition, validation: 'strict' });
    const res = await call(strict, '/meta/movie/tt1.json');
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /date-time with its zone/);
  });

  test('a handler crash is logged with its request but hidden from the client, and the configuration is never logged', async () => {
    const logs = collectLogs();
    const addon = defineAddon({
      manifest: manifest(),
      config: z.object({ apiKey: z.string() }),
      stream: async ({ log }) => {
        log.info({}, 'asking the upstream');
        throw new Error('upstream refused the key');
      },
    });
    const link = await addon.manifestUrl(BASE, { apiKey: 'key-hunter2' });
    const path = new URL(link).pathname.replace(
      'manifest.json',
      'stream/movie/tt1.json'
    );
    const res = await call(addon, path);
    assert.equal(res.status, 500);
    assert.doesNotMatch(await res.text(), /upstream refused/);

    const [handler, failure] = logs;
    assert.equal(handler.fields.resource, 'stream');
    assert.equal(failure.level, 'error');
    assert.equal(
      (failure.fields.err as Error).message,
      'upstream refused the key'
    );
    assert.equal(failure.fields.rid, handler.fields.rid);
    assert.equal(failure.fields.path, '/{config}/stream/movie/tt1.json');
    const segment = path.split('/')[1];
    assert.ok(!JSON.stringify(logs).includes(segment));
  });
});

describe('client events', () => {
  test('player and library events arrive parsed', async () => {
    const events: unknown[] = [];
    const addon = defineAddon({
      manifest: manifest({ resources: ['player', 'library'] }),
      player: async ({ id, action, currentTime, duration }) => {
        events.push({ id, action, currentTime, duration });
      },
      library: async ({ id, action, videoIds }) => {
        events.push({ id, action, videoIds });
      },
    });
    await call(
      addon,
      '/player/series/tt1%3A1%3A2/action=pause&currentTime=61000&duration=0.json'
    );
    await call(
      addon,
      '/library/series/tt1/action=watched&videoId=tt1%3A1%3A1%2Ctt1%3A1%3A2.json'
    );
    await call(addon, '/library/movie/tt2/action=libraryAdd.json');
    assert.deepEqual(events, [
      {
        id: 'tt1:1:2',
        action: 'pause',
        currentTime: 61000,
        duration: undefined,
      },
      { id: 'tt1', action: 'watched', videoIds: ['tt1:1:1', 'tt1:1:2'] },
      { id: 'tt2', action: 'libraryAdd', videoIds: [] },
    ]);
  });
});
