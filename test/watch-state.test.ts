import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  defineAddon,
  type PullResult,
  type WatchStateEvent,
} from '../src/index.js';
import { call, collectLogs, manifest } from './helpers.js';

const tracker = (pull: () => PullResult | Promise<PullResult>) =>
  defineAddon({
    manifest: manifest({
      resources: ['watch_state'],
      watchState: {
        version: 2,
        pull: { items: true, watched: true, watchlist: true },
      },
    }),
    watchState: { pull: async () => pull() },
  });

const pull = async (addon: ReturnType<typeof tracker>, since?: string) =>
  (
    await call(addon, `/watch_state/pull.json${since ? `?since=${since}` : ''}`)
  ).json();

describe('watch state pull', () => {
  test('a matching version skips the watched library without reading it', async () => {
    let reads = 0;
    const addon = tracker(() => ({
      version: 'v7',
      items: [],
      watched: () => {
        reads++;
        return { movies: ['tt1'] };
      },
    }));
    assert.deepEqual(await pull(addon, 'v7'), { version: 'v7', items: [] });
    assert.equal(reads, 0);
    assert.deepEqual(await pull(addon, 'v6'), {
      version: 'v7',
      items: [],
      watched: { movies: ['tt1'] },
    });
    assert.equal(reads, 1);
  });

  test('a failed read sends neither the library nor its version, so nothing is wiped and the next read asks again', async () => {
    const logs = collectLogs();
    const addon = defineAddon({
      manifest: manifest({
        resources: ['watch_state'],
        watchState: {
          version: 2,
          pull: { items: true, watched: true, watchlist: true },
        },
      }),
      watchState: {
        pull: async () => ({
          version: 'v8',
          items: [{ metaId: 'tt1', videoId: 'tt1', positionMs: 5000 }],
          watched: () => {
            throw new Error('tracker timed out');
          },
          watchlist: () => [{ type: 'movie', metaId: 'tt2' }],
        }),
      },
    });
    assert.deepEqual(await pull(addon, 'v7'), {
      items: [{ metaId: 'tt1', videoId: 'tt1', positionMs: 5000 }],
      watchlist: [{ type: 'movie', metaId: 'tt2' }],
    });
    const warning = logs.find((entry) => entry.level === 'warn');
    assert.equal((warning?.fields.err as Error).message, 'tracker timed out');
  });

  test('an empty library is sent as empty, unlike an unknown one', async () => {
    const empty = tracker(() => ({
      version: 'v1',
      watched: { movies: [], episodes: [] },
    }));
    assert.deepEqual(await pull(empty), {
      version: 'v1',
      watched: { movies: [], episodes: [] },
    });

    const unknown = tracker(() => ({
      version: 'v1',
      watched: () => undefined,
    }));
    assert.deepEqual(await pull(unknown), {});
  });
});

describe('watch state push', () => {
  function pusher(handle: (event: WatchStateEvent, viewer?: string) => void) {
    return defineAddon({
      manifest: manifest({
        resources: ['watch_state'],
        watchState: { version: 2, viewers: true, push: { bulk: true } },
      }),
      watchState: { push: async ({ event, viewer }) => handle(event, viewer) },
    });
  }
  const post = (
    addon: ReturnType<typeof pusher>,
    path: string,
    body: unknown
  ) =>
    call(addon, path, {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  const stop = {
    id: 'e|tt1:1:2|stop|2680000|1757438900000',
    event: 'stop',
    scope: 'episode',
    at: 1757441718,
    metaId: 'tt1',
    videoId: 'tt1:1:2',
    positionMs: 2680000,
    durationMs: 2820000,
    played: true,
    season: 1,
    episode: 2,
    ids: { imdb: 'tt1' },
  };

  test('a retried event is applied once per viewer, but a failed one is retried', async () => {
    const applied: string[] = [];
    let fail = true;
    const addon = pusher((event, viewer) => {
      if (fail) {
        fail = false;
        throw new Error('tracker down');
      }
      applied.push(`${viewer}:${event.id}`);
    });
    const path = '/watch_state/push/series/tt1%3A1%3A2.json';
    assert.equal((await post(addon, path, stop)).status, 500);
    assert.equal((await post(addon, path, stop)).status, 204);
    assert.equal((await post(addon, path, stop)).status, 204);
    assert.equal((await post(addon, `${path}?viewer=sam`, stop)).status, 204);
    assert.deepEqual(applied, [`undefined:${stop.id}`, `sam:${stop.id}`]);
  });

  test('events from senders that leave out scope are read as one video', async () => {
    const events: WatchStateEvent[] = [];
    const addon = pusher((event) => events.push(event));
    const { scope, ...old } = stop;
    await post(addon, '/watch_state/push/series/tt1%3A1%3A2.json', old);
    await post(addon, '/watch_state/push/movie/tt9.json', {
      ...old,
      id: 'm',
      metaId: 'tt9',
      videoId: 'tt9',
    });
    assert.deepEqual(
      events.map((e) => e.scope),
      ['episode', 'movie']
    );
  });

  test('a malformed event is refused with the reason, so the sender drops it', async () => {
    const addon = pusher(() => assert.fail('should not run'));
    const path = '/watch_state/push/series/tt1.json';
    const bad = await post(addon, path, { ...stop, positionMs: -1 });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /positionMs/);
    assert.equal((await post(addon, path, '{')).status, 400);
    assert.equal(
      (await post(addon, path, `"${'x'.repeat(1024 * 1024)}"`)).status,
      413
    );
  });

  test('push is answered only when the manifest declares it', async () => {
    const pullOnly = tracker(() => ({}));
    const res = await call(pullOnly, '/watch_state/push/series/tt1.json', {
      method: 'POST',
      body: JSON.stringify(stop),
    });
    assert.equal(res.status, 404);
  });
});
