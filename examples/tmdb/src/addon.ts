import {
  AddonError,
  configureLogging,
  createLogger,
  defineAddon,
  defineEnv,
  notFound,
  type CatalogEntry,
  type ContentType,
  type Meta,
} from '@aiostreams/addon-sdk';
import { serve } from '@aiostreams/addon-sdk/node';
import { z } from 'zod';

const env = defineEnv({
  PORT: z.coerce.number().int().default(7002),
  CONFIG_SECRET: z.string().min(32).optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});
configureLogging({ level: env.LOG_LEVEL });
const log = createLogger('tmdb');
if (!env.CONFIG_SECRET) {
  log.warn(
    {},
    'CONFIG_SECRET is not set: API keys can be read from install links'
  );
}

const HOUR = 3600;

type Kind = 'movie' | 'tv';
const List = z.enum(['Trending', 'Popular', 'Top rated']);
const LIST_PATHS: Record<z.infer<typeof List>, (kind: Kind) => string> = {
  Trending: (kind) => `trending/${kind}/week`,
  Popular: (kind) => `${kind}/popular`,
  'Top rated': (kind) => `${kind}/top_rated`,
};
const catalogId = (list: string) => list.toLowerCase().replace(/ /g, '-');

const Settings = z.object({
  apiKey: z.string().trim().min(1).meta({
    title: 'TMDB API key',
    description:
      'The **API key** or **read access token** from [your TMDB settings](https://www.themoviedb.org/settings/api), free with an account.',
    writeOnly: true,
  }),
  lists: z.array(List).default(['Trending', 'Popular']).meta({
    title: 'Catalogs',
    description: 'Each one is listed for movies and for series.',
  }),
  search: z
    .boolean()
    .default(true)
    .meta({ description: 'Search TMDB for movies and series.' }),
  language: z
    .enum([
      'en-US',
      'de-DE',
      'es-ES',
      'fr-FR',
      'hi-IN',
      'it-IT',
      'ja-JP',
      'ko-KR',
      'pt-BR',
    ])
    .default('en-US')
    .meta({
      description: 'Titles and overviews are translated where TMDB can.',
    }),
});
type Settings = z.output<typeof Settings>;

interface Title {
  id: number;
  title?: string;
  name?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  release_date?: string;
  first_air_date?: string;
  vote_average: number;
  vote_count: number;
}

interface Details extends Title {
  original_title?: string;
  original_name?: string;
  tagline?: string;
  genres: { name: string }[];
  runtime?: number;
  homepage?: string;
  production_companies: { name: string }[];
  networks?: { name: string }[];
  created_by?: { name: string }[];
  in_production?: boolean;
  last_air_date?: string | null;
  seasons?: {
    season_number: number;
    name: string;
    overview: string;
    poster_path: string | null;
    air_date: string | null;
  }[];
  external_ids: { imdb_id?: string | null; tvdb_id?: number | null };
  credits: {
    cast: { name: string; character?: string; profile_path: string | null }[];
    crew: { name: string; job: string }[];
  };
  videos: {
    results: { key: string; name: string; site: string; type: string }[];
  };
}

interface Season {
  episodes: {
    season_number: number;
    episode_number: number;
    name: string;
    overview: string;
    air_date: string | null;
    still_path: string | null;
  }[];
}

async function tmdb<T>(
  path: string,
  config: Settings,
  params: Record<string, string | number | undefined> = {}
): Promise<T> {
  const url = new URL(`https://api.themoviedb.org/3/${path}`);
  url.searchParams.set('language', config.language);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  // A read access token is a JWT and goes in a header; an API key goes in the query.
  const token = config.apiKey.startsWith('eyJ');
  if (!token) url.searchParams.set('api_key', config.apiKey);
  const res = await fetch(url, {
    headers: token ? { authorization: `Bearer ${config.apiKey}` } : {},
    signal: AbortSignal.timeout(10_000),
  });
  if (res.ok) return (await res.json()) as T;
  if (res.status === 401) throw new AddonError(401, 'TMDB refused the API key');
  if (res.status === 404) notFound();
  if (res.status === 429) {
    throw new AddonError(429, 'TMDB is rate limiting this addon', {
      retryAfter: Number(res.headers.get('retry-after')) || 10,
    });
  }
  throw new Error(`TMDB answered ${res.status} to ${path}`);
}

const image = (path: string | null | undefined, size: string) =>
  path ? `https://image.tmdb.org/t/p/${size}${path}` : undefined;
// TMDB dates are plain days, and empty when unknown.
const dateTime = (date: string | null | undefined) =>
  date ? `${date}T00:00:00Z` : undefined;

function entry(type: ContentType, title: Title): CatalogEntry {
  const date = title.release_date || title.first_air_date || undefined;
  return {
    id: `tmdb:${title.id}`,
    type,
    name: title.title ?? title.name ?? '',
    poster: image(title.poster_path, 'w500'),
    background: image(title.backdrop_path, 'original'),
    landscapePoster: image(title.backdrop_path, 'w780'),
    description: title.overview || undefined,
    releaseInfo: date?.slice(0, 4),
    released: dateTime(date),
    ratings: title.vote_count
      ? [{ source: 'tmdb', value: title.vote_average, scale: 10 }]
      : undefined,
    ids: { tmdb: title.id },
  };
}

async function episodes(id: string, details: Details, config: Settings) {
  const seasons = await Promise.all(
    (details.seasons ?? []).map((season) =>
      tmdb<Season>(`tv/${id}/season/${season.season_number}`, config)
    )
  );
  return seasons.flatMap((season) =>
    season.episodes.map((episode) => ({
      id: `tmdb:${id}:${episode.season_number}:${episode.episode_number}`,
      title: episode.name,
      season: episode.season_number,
      episode: episode.episode_number,
      released: dateTime(episode.air_date),
      overview: episode.overview || undefined,
      thumbnail: image(episode.still_path, 'w300'),
    }))
  );
}

const addon = defineAddon({
  manifest: (config) => ({
    id: 'com.example.tmdb',
    version: '1.0.0',
    name: 'TMDB Catalogs',
    // The notice TMDB's terms ask for, word for word.
    description:
      'Trending, popular and top rated movies and series, with full metadata. This addon uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB.',
    // TMDB's terms rule out its logo and images as the addon's own.
    logo: 'https://cdn.jsdelivr.net/gh/microsoft/fluentui-emoji@main/assets/Clapper%20board/3D/clapper_board_3d.png',
    background:
      'https://images.unsplash.com/photo-1595769816263-9b910be24d5f?w=1920&q=80&auto=format',
    types: ['movie', 'series'],
    idPrefixes: ['tmdb:'],
    resources: ['catalog', 'meta'],
    catalogs: [
      ...(config?.lists ?? List.options).flatMap((list) =>
        (['movie', 'series'] as const).map((type) => ({
          type,
          id: catalogId(list),
          name: list,
          extra: [{ name: 'skip' }],
        }))
      ),
      ...(config?.search === false
        ? []
        : (['movie', 'series'] as const).map((type) => ({
            type,
            id: 'search',
            name: 'Search',
            extra: [{ name: 'search', isRequired: true }],
          }))),
    ],
    behaviorHints: { configurable: true, configurationRequired: true },
  }),

  config: { schema: Settings, secret: env.CONFIG_SECRET },
  theme: { accent: '#01b4e4' },
  // TMDB's terms ask apps to show its logo, less prominently than their own.
  footer:
    '[![TMDB](https://www.themoviedb.org/assets/2/v4/logos/v2/blue_short-8e7b30f73a4020692ccca9c88bafe5dcb6f8a62a4c6bc55cd9ba82bb2cd95f6c.svg)](https://www.themoviedb.org)\n\nMetadata and images from [TMDB](https://www.themoviedb.org).',

  catalog: async ({ type, id, extra, config }) => {
    const kind = type === 'movie' ? 'movie' : 'tv';
    const list = List.options.find((name) => catalogId(name) === id);
    const path =
      id === 'search'
        ? `search/${kind}`
        : list
          ? LIST_PATHS[list](kind)
          : notFound();
    const { results } = await tmdb<{ results: Title[] }>(path, config, {
      // TMDB pages hold 20 titles.
      page: Math.floor((extra.skip ?? 0) / 20) + 1,
      query: extra.search,
    });
    return {
      metas: results.map((title) => entry(type, title)),
      cacheMaxAge: id === 'search' ? HOUR : 6 * HOUR,
    };
  },

  meta: async ({ type, id, config }) => {
    const tmdbId = /^tmdb:(\d+)$/.exec(id)?.[1];
    if (!tmdbId || (type !== 'movie' && type !== 'series')) return null;
    const kind = type === 'movie' ? 'movie' : 'tv';
    const details = await tmdb<Details>(`${kind}/${tmdbId}`, config, {
      append_to_response: 'credits,videos,external_ids',
      include_video_language: `${config.language.slice(0, 2)},en`,
    });
    const meta: Meta = {
      ...entry(type, details),
      originalTitle: details.original_title ?? details.original_name,
      tagline: details.tagline || undefined,
      genres: details.genres.map((genre) => genre.name),
      ids: {
        tmdb: details.id,
        imdb: details.external_ids.imdb_id || undefined,
        tvdb: details.external_ids.tvdb_id || undefined,
      },
      people: [
        ...(details.created_by ?? []).map(({ name }) => ({
          name,
          role: 'creator' as const,
        })),
        ...details.credits.crew
          .filter((member) => member.job === 'Director')
          .map(({ name }) => ({ name, role: 'director' as const })),
        ...details.credits.cast.slice(0, 15).map((member) => ({
          name: member.name,
          role: 'actor' as const,
          character: member.character || undefined,
          photo: image(member.profile_path, 'w185'),
        })),
      ],
      trailers: details.videos.results
        .filter((video) => video.site === 'YouTube' && video.type === 'Trailer')
        .map((video) => ({
          source: video.key,
          type: 'Trailer',
          name: video.name,
        })),
      studios: details.production_companies.map((company) => company.name),
      website: details.homepage || undefined,
    };

    if (kind === 'movie') {
      meta.runtime = details.runtime ? `${details.runtime} min` : undefined;
      return { meta, cacheMaxAge: 24 * HOUR };
    }

    if (!details.in_production && details.last_air_date) {
      meta.endDate = details.last_air_date;
      if (meta.releaseInfo) {
        meta.releaseInfo = `${meta.releaseInfo}-${details.last_air_date.slice(0, 4)}`;
      }
    }
    meta.networks = details.networks?.map((network) => network.name);
    meta.seasons = details.seasons?.map((season) => ({
      season: season.season_number,
      name: season.name,
      overview: season.overview || undefined,
      poster: image(season.poster_path, 'w500'),
      released: dateTime(season.air_date),
    }));
    meta.videos = await episodes(tmdbId, details, config);
    return { meta, cacheMaxAge: 6 * HOUR };
  },
});

await serve(addon, { port: env.PORT });
