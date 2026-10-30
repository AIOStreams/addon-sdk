import { z } from 'zod';
import {
  ContentTypeSchema,
  CountSchema,
  DateTimeSchema,
  ProviderIdsSchema,
  UrlSchema,
} from './common.js';
import { StreamSchema } from './stream.js';

export const LinkSchema = z.object({
  name: z.string(),
  /** Links are grouped by category, e.g. `Genres`, `Cast`, `Directors`. */
  category: z.string(),
  /** An http(s) address or a `stremio:///` link. */
  url: UrlSchema,
});

export type TrailerType = 'Trailer' | 'Clip' | (string & {});

export const TrailerSchema = z.object({
  /** A YouTube video id, or a video's address. */
  source: z.string().min(1),
  /** `Trailer` for a YouTube id; another type, such as `Video`, for an address. */
  type: z.string() as unknown as z.ZodType<TrailerType, TrailerType>,
  name: z.string().nullish(),
});

export const PERSON_ROLES = [
  'actor',
  'director',
  'writer',
  'producer',
  'composer',
  'creator',
  'guestStar',
] as const;

export const PersonSchema = z.object({
  name: z.string().min(1),
  role: z.enum(PERSON_ROLES),
  character: z.string().nullish(),
  photo: z.string().nullish(),
  /** A person meta id, opened as a meta of type `person`. */
  id: z.string().nullish(),
});

export const RATING_SOURCES = [
  'imdb',
  'tomatoes',
  'tomatoesAudience',
  'metacritic',
  'letterboxd',
  'rogerebert',
  'trakt',
  'tmdb',
  'mal',
] as const;

export const RatingSchema = z.object({
  source: z.enum(RATING_SOURCES),
  value: z.number().min(0),
  /** What `value` is out of; the source's usual scale when absent. */
  scale: z.number().positive().nullish(),
});

export const SeasonSchema = z.object({
  /** Matches the `season` of the videos it describes; `0` is specials. */
  season: CountSchema,
  name: z.string().nullish(),
  overview: z.string().nullish(),
  poster: z.string().nullish(),
  released: z.string().nullish(),
});

export const CollectionSourceSchema = z.object({
  type: ContentTypeSchema,
  catalogId: z.string().min(1),
  /** The catalog must declare a `genre` extra. */
  genre: z.string().nullish(),
  /** Another addon's manifest id or URL; omit it for your own. */
  addonId: z.string().nullish(),
});

export const MetaBehaviorHintsSchema = z.object({
  defaultVideoId: z.string().nullish(),
  featuredVideoId: z.string().nullish(),
  hasScheduledVideos: z.boolean().nullish(),
  isLive: z.boolean().nullish(),
});

const ImageSchema = z.union([UrlSchema, z.literal('')]);
const TextOrNumberSchema = z.union([z.string(), z.number()]);

export const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/** A title as a catalog lists it. */
export const CatalogEntrySchema = z.object({
  id: z.string().min(1),
  type: ContentTypeSchema,
  name: z.string(),
  poster: ImageSchema.nullish(),
  posterShape: z.enum(['poster', 'square', 'landscape']).nullish(),
  background: ImageSchema.nullish(),
  logo: ImageSchema.nullish(),
  description: z.string().nullish(),
  /** Shown as the year, e.g. `2008-2013`. */
  releaseInfo: TextOrNumberSchema.nullish(),
  released: DateTimeSchema.nullish(),
  runtime: TextOrNumberSchema.nullish(),
  links: z.array(LinkSchema).nullish(),
  trailers: z.array(TrailerSchema).nullish(),
  trailerStreams: z.array(StreamSchema).nullish(),
  behaviorHints: MetaBehaviorHintsSchema.nullish(),
  /** Read as genre links when `links` is absent. */
  genres: z.array(z.string()).nullish(),
  imdbRating: TextOrNumberSchema.nullish(),
  director: z.array(z.string()).nullish(),
  cast: z.array(z.string()).nullish(),

  ids: ProviderIdsSchema.nullish(),
  /** The wide card on Continue Watching, Next Up and home rows. */
  landscapePoster: z.string().nullish(),
  /** A GIF, animated WebP or APNG played over the poster while its card has focus. */
  animatedPoster: z.string().nullish(),
  originalTitle: z.string().nullish(),
  tagline: z.string().nullish(),
  people: z.array(PersonSchema).nullish(),
  certification: z.string().nullish(),
  /** The rating in the viewer's country. */
  certificationLocal: z.string().nullish(),
  /** 0 to 100. */
  criticRating: z.number().min(0).max(100).nullish(),
  /** In the order to show them; where room is short only the first three show. */
  ratings: z.array(RatingSchema).nullish(),
  studios: z.array(z.string()).nullish(),
  networks: z.array(z.string()).nullish(),
  /** English names or ISO 3166 codes. */
  countries: z.array(z.string()).nullish(),
  tags: z.array(z.string()).nullish(),
  /** A series' last air date. */
  endDate: z.string().nullish(),
  airDays: z.array(z.enum(WEEKDAYS)).nullish(),
  /** e.g. `21:00`. */
  airTime: z.string().nullish(),
  seasons: z.array(SeasonSchema).nullish(),
  /** `YYYY-MM-DD`, on a `person`. */
  birthday: z.string().nullish(),
  deathday: z.string().nullish(),
  birthPlace: z.string().nullish(),
});

export const MetaPreviewSchema = CatalogEntrySchema.extend({
  /** Makes the meta a collection; `{}` on a catalog entry marks one without listing its members. */
  collection: z
    .object({
      items: z.array(CatalogEntrySchema).nullish(),
      sources: z.array(CollectionSourceSchema).nullish(),
    })
    .nullish(),
  /** A `person`'s filmography, best known first. */
  credits: z.array(CatalogEntrySchema).nullish(),
});

export const ContentRatingSchema = z.object({
  value: z.string(),
  system: z.string().nullish(),
  icon: z.string().nullish(),
});

export const VideoSchema = z.object({
  id: z.string().min(1),
  title: z.string().nullish(),
  released: DateTimeSchema.nullish(),
  overview: z.string().nullish(),
  thumbnail: z.string().nullish(),
  /** Played without a `stream` request. */
  streams: z.array(StreamSchema).nullish(),
  /** Read as a pair: one without the other is ignored. */
  season: CountSchema.nullish(),
  episode: CountSchema.nullish(),
  trailerStreams: z.array(StreamSchema).nullish(),
  /** A live TV programme needs both. */
  startTime: z.iso.datetime({ offset: true }).nullish(),
  endTime: z.iso.datetime({ offset: true }).nullish(),
  runtime: z.string().nullish(),
  releaseInfo: z.string().nullish(),
  genres: z.array(z.string()).nullish(),
  cast: z.array(z.string()).nullish(),
  directors: z.array(z.string()).nullish(),
  links: z.array(LinkSchema).nullish(),
  ratings: z.array(ContentRatingSchema).nullish(),
  imdbId: z.string().nullish(),
  background: z.string().nullish(),

  /** The episode's own ids, never the show's. */
  ids: ProviderIdsSchema.nullish(),
  /** 0 to 10; numeric text is read too. */
  rating: z.union([z.number().min(0).max(10), z.string()]).nullish(),
  people: z.array(PersonSchema).nullish(),
  filler: z.boolean().nullish(),
  recap: z.boolean().nullish(),
});

export const MetaSchema = MetaPreviewSchema.extend({
  videos: z.array(VideoSchema).nullish(),
  language: z.string().nullish(),
  country: z.string().nullish(),
  awards: z.string().nullish(),
  website: z.string().nullish(),
});

export type Link = z.input<typeof LinkSchema>;
export type Trailer = z.input<typeof TrailerSchema>;
export type PersonRole = (typeof PERSON_ROLES)[number];
export type Person = z.input<typeof PersonSchema>;
export type RatingSource = (typeof RATING_SOURCES)[number];
export type Rating = z.input<typeof RatingSchema>;
export type Season = z.input<typeof SeasonSchema>;
export type CollectionSource = z.input<typeof CollectionSourceSchema>;
export type CatalogEntry = z.input<typeof CatalogEntrySchema>;
export type MetaPreview = z.input<typeof MetaPreviewSchema>;
export type ContentRating = z.input<typeof ContentRatingSchema>;
export type Video = z.input<typeof VideoSchema>;
export type Meta = z.input<typeof MetaSchema>;
