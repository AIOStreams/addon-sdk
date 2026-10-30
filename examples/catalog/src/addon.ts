import {
  configureLogging,
  defineAddon,
  defineEnv,
  notFound,
  type CatalogEntry,
  type Meta,
} from '@aiostreams/addon-sdk';
import { serve } from '@aiostreams/addon-sdk/node';
import { z } from 'zod';

const env = defineEnv({
  PORT: z.coerce.number().int().default(7000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

const films: Meta[] = [
  {
    id: 'tt1375666',
    type: 'movie',
    name: 'Inception',
    released: '2010-07-16T00:00:00Z',
    releaseInfo: '2010',
    poster: 'https://images.metahub.space/poster/medium/tt1375666/img',
    landscapePoster:
      'https://images.metahub.space/background/medium/tt1375666/img',
    tagline: 'Your mind is the scene of the crime.',
    ids: { imdb: 'tt1375666', tmdb: '27205' },
    certification: 'PG-13',
    ratings: [
      { source: 'imdb', value: 8.8 },
      { source: 'tomatoes', value: 87 },
    ],
    studios: ['Legendary Pictures', 'Syncopy'],
    countries: ['US', 'GB'],
    people: [
      { name: 'Christopher Nolan', role: 'director', id: 'tmdb:525' },
      { name: 'Leonardo DiCaprio', role: 'actor', character: 'Cobb' },
    ],
    trailers: [
      { source: 'YoHD9XEInc0', type: 'Trailer', name: 'Official Trailer' },
    ],
  },
  {
    id: 'tt0816692',
    type: 'movie',
    name: 'Interstellar',
    released: '2014-11-07T00:00:00Z',
    releaseInfo: '2014',
    poster: 'https://images.metahub.space/poster/medium/tt0816692/img',
    ids: { imdb: 'tt0816692', tmdb: '157336' },
    people: [{ name: 'Christopher Nolan', role: 'director', id: 'tmdb:525' }],
  },
];

const nolan: Meta = {
  id: 'tmdb:525',
  type: 'person',
  name: 'Christopher Nolan',
  description: 'A British and American filmmaker.',
  birthday: '1970-07-30',
  birthPlace: 'London, England, UK',
  ids: { tmdb: '525', imdb: 'nm0634240' },
  credits: films.map(({ id, type, name, poster, released }) => ({
    id,
    type,
    name,
    poster,
    released,
  })),
};

const entry = ({
  id,
  type,
  name,
  poster,
  landscapePoster,
  releaseInfo,
}: Meta): CatalogEntry => ({
  id,
  type,
  name,
  poster,
  landscapePoster,
  releaseInfo,
});

const addon = defineAddon({
  manifest: {
    id: 'com.example.catalog',
    version: '1.0.0',
    name: 'Example Catalog',
    description: 'Films with the metadata AIOStreams reads.',
    types: ['movie', 'person'],
    idPrefixes: ['tt', 'tmdb:'],
    resources: ['catalog', 'meta', 'stream', 'subtitles'],
    catalogs: [
      { type: 'movie', id: 'nolan', name: 'Nolan', extra: [{ name: 'skip' }] },
      {
        type: 'movie',
        id: 'similar',
        name: 'More Like This',
        extra: [{ name: 'similar', isRequired: true }],
        idPrefixes: ['tt'],
      },
      {
        type: 'person',
        id: 'people',
        name: 'People',
        extra: [{ name: 'search', isRequired: true }],
      },
    ],
    behaviorHints: { configurable: true },
  },

  // Served as a form at /configure.
  config: z.object({
    language: z
      .enum(['eng', 'fre', 'spa', 'ger'])
      .default('eng')
      .meta({ title: 'Subtitle language' }),
  }),

  catalog: ({ id, extra }) => {
    if (id === 'people') {
      const match = nolan.name
        .toLowerCase()
        .includes(extra.search?.toLowerCase() ?? '');
      return { metas: match ? [entry(nolan)] : [] };
    }
    if (id === 'similar') {
      return {
        metas: films.filter((film) => film.id !== extra.similar).map(entry),
      };
    }
    return {
      metas: films.slice(extra.skip ?? 0).map(entry),
      cacheMaxAge: 3600,
    };
  },

  meta: ({ id }) => {
    const meta = id === nolan.id ? nolan : films.find((film) => film.id === id);
    return meta ? { meta } : null;
  },

  stream: ({ id }) => {
    const film = films.find((f) => f.id === id) ?? notFound();
    const filename = `${film.name}.${film.releaseInfo}.1080p.WEB-DL.x264-GROUP.mkv`;
    return {
      streams: [
        {
          name: 'Example\n1080p',
          description: filename,
          url: `https://cdn.example.com/${encodeURIComponent(filename)}`,
          behaviorHints: { filename, videoSize: 2_147_483_648, duration: 8880 },
        },
      ],
    };
  },

  subtitles: ({ id, config }) => ({
    subtitles: [
      {
        id: `${id}-${config.language}`,
        url: `https://subs.example.com/${id}.${config.language}.srt`,
        lang: config.language,
        label: 'WEB-DL',
      },
    ],
  }),
});

configureLogging({ level: env.LOG_LEVEL });
await serve(addon, { port: env.PORT });
