import { z } from 'zod';

export type ContentType =
  'movie' | 'series' | 'channel' | 'tv' | 'anime' | 'person' | (string & {});

export const ContentTypeSchema = z.string().min(1) as unknown as z.ZodType<
  ContentType,
  ContentType
>;

export const PROVIDER_IDS = [
  'imdb',
  'tmdb',
  'tvdb',
  'mal',
  'anilist',
  'kitsu',
  'anidb',
  'simkl',
  'trakt',
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export const ProviderIdsSchema = z.partialRecord(
  z.enum(PROVIDER_IDS),
  z.union([z.string().min(1), z.number()]).optional()
);

export type ProviderIds = z.input<typeof ProviderIdsSchema>;

/** A relative or malformed address makes the object holding it unreadable. */
export const UrlSchema = z.url({ error: 'expected an absolute address' });

/** A date alone is refused: give a date-time with its zone, or epoch milliseconds. */
const DATE_TIME_MESSAGE =
  'expected a date-time with its zone, e.g. 2008-01-20T00:00:00Z, or epoch milliseconds';

export const DateTimeSchema = z.union(
  [
    z.iso.datetime({ offset: true, error: DATE_TIME_MESSAGE }),
    z.number().int(),
  ],
  { error: DATE_TIME_MESSAGE }
);

export const CountSchema = z.number().int().min(0);
