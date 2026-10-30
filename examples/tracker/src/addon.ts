import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  configureLogging,
  createLogger,
  defineAddon,
  defineEnv,
  type PullItem,
  type WatchStateEvent,
} from '@aiostreams/addon-sdk';
import { serve } from '@aiostreams/addon-sdk/node';
import { z } from 'zod';

const env = defineEnv({
  PORT: z.coerce.number().int().default(7001),
  DATA_FILE: z.string().default('data/tracker.json'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});
configureLogging({ level: env.LOG_LEVEL });
const log = createLogger('store');

interface History {
  inProgress: Record<string, PullItem>;
  movies: string[];
  episodes: string[];
  watchlist: Record<string, { type: string; at: number }>;
  changed: number;
}

const empty = (): History => ({
  inProgress: {},
  movies: [],
  episodes: [],
  watchlist: {},
  changed: 0,
});

let store: Record<string, History> = await readFile(env.DATA_FILE, 'utf8')
  .then((text) => JSON.parse(text))
  .catch((err) => {
    // Anything but a missing file would be overwritten on the first event.
    if (err.code !== 'ENOENT') throw err;
    log.info({ file: env.DATA_FILE }, 'starting with no history');
    return {};
  });

async function update(
  viewer: string | undefined,
  change: (history: History) => void
) {
  const history = (store[viewer ?? ''] ??= empty());
  change(history);
  history.changed = Date.now();
  await mkdir(dirname(env.DATA_FILE), { recursive: true });
  await writeFile(env.DATA_FILE, JSON.stringify(store));
}

const toggle = (list: string[], id: string, on: boolean) =>
  on ? [...new Set([...list, id])] : list.filter((item) => item !== id);

function apply(history: History, event: WatchStateEvent) {
  const now = event.at;
  switch (event.event) {
    case 'start':
    case 'pause':
    case 'stop': {
      const played = event.event === 'stop' && event.played;
      if (played || event.positionMs === 0)
        delete history.inProgress[event.videoId];
      else
        history.inProgress[event.videoId] = {
          type: event.scope === 'movie' ? 'movie' : 'series',
          metaId: event.metaId,
          videoId: event.videoId,
          season: event.season,
          episode: event.episode,
          positionMs: event.positionMs,
          durationMs: event.durationMs,
          at: now,
        };
      if (played) markWatched(history, event.scope, [event.videoId], true);
      break;
    }
    case 'played':
    case 'unplayed': {
      const on = event.event === 'played';
      if ('videos' in event)
        markWatched(
          history,
          'episode',
          event.videos.map((v) => v.videoId),
          on
        );
      else markWatched(history, event.scope, [event.videoId], on);
      break;
    }
    case 'watchlisted':
      history.watchlist[event.metaId] = { type: event.scope, at: now };
      break;
    case 'unwatchlisted':
      delete history.watchlist[event.metaId];
      break;
  }
}

function markWatched(
  history: History,
  scope: string,
  ids: string[],
  on: boolean
) {
  for (const id of ids) {
    if (scope === 'movie') history.movies = toggle(history.movies, id, on);
    else history.episodes = toggle(history.episodes, id, on);
    if (on) delete history.inProgress[id];
  }
}

const addon = defineAddon({
  manifest: {
    id: 'com.example.tracker',
    version: '1.0.0',
    name: 'Example Tracker',
    description:
      'Keeps watch history in a file, from AIOStreams and from the client player.',
    types: ['movie', 'series'],
    resources: ['watch_state', 'player', 'library'],
    watchState: {
      version: 2,
      viewers: true,
      push: {
        events: [
          'start',
          'pause',
          'stop',
          'played',
          'unplayed',
          'watchlisted',
          'unwatchlisted',
        ],
        bulk: true,
      },
      pull: { items: true, watched: true, watchlist: true, ttlSeconds: 60 },
    },
  },

  watchState: {
    push: ({ event, viewer }) =>
      update(viewer, (history) => apply(history, event)),
    pull: ({ viewer }) => {
      const history = store[viewer ?? ''] ?? empty();
      return {
        version: String(history.changed),
        items: Object.values(history.inProgress),
        watched: () => ({ movies: history.movies, episodes: history.episodes }),
        watchlist: Object.entries(history.watchlist).map(
          ([metaId, { type, at }]) => ({
            type,
            metaId,
            at,
          })
        ),
      };
    },
  },

  // Player and library events carry no viewer.
  player: ({ type, id, action, currentTime, duration }) =>
    update(undefined, (history) => {
      const finished =
        action === 'stop' && duration && currentTime >= duration * 0.9;
      if (finished)
        markWatched(
          history,
          type === 'movie' ? 'movie' : 'episode',
          [id],
          true
        );
      else
        history.inProgress[id] = {
          type,
          metaId: id.split(':')[0],
          videoId: id,
          positionMs: currentTime,
          durationMs: duration,
          at: Math.floor(Date.now() / 1000),
        };
    }),
  library: ({ type, id, action, videoIds }) =>
    update(undefined, (history) => {
      if (action === 'libraryAdd')
        history.watchlist[id] = { type, at: Math.floor(Date.now() / 1000) };
      else if (action === 'libraryRemove') delete history.watchlist[id];
      else
        markWatched(
          history,
          type === 'movie' ? 'movie' : 'episode',
          videoIds.length ? videoIds : [id],
          action === 'watched'
        );
    }),
});

await serve(addon, { port: env.PORT });
