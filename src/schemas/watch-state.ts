import { z } from 'zod';
import { ContentTypeSchema, CountSchema, ProviderIdsSchema } from './common.js';

export const PLAYBACK_EVENTS = ['start', 'pause', 'stop'] as const;
export const MARK_EVENTS = ['played', 'unplayed'] as const;
export const LIST_EVENTS = [
  'watchlisted',
  'unwatchlisted',
  'dropped',
  'undropped',
] as const;
export const RATING_EVENTS = ['rated', 'unrated'] as const;
export const WATCH_STATE_EVENTS = [
  ...PLAYBACK_EVENTS,
  ...MARK_EVENTS,
  ...LIST_EVENTS,
  ...RATING_EVENTS,
] as const;

export type WatchStateEventName = (typeof WATCH_STATE_EVENTS)[number];

const NumberingSchema = CountSchema.nullish();

const eventFields = {
  /** Identical across retries. */
  id: z.string().min(1),
  /** Unix seconds. */
  at: z.number(),
  /** The meta the video belongs to; it may be in another id space from `videoId`. */
  metaId: z.string().min(1),
  /** The show's or film's ids, never an episode's. */
  ids: ProviderIdsSchema.default({}),
};

const videoFields = {
  videoId: z.string().min(1),
  /** The metadata addon's numbering; `null` with absolute numbering. */
  season: NumberingSchema,
  episode: NumberingSchema,
};

export const PlaybackEventSchema = z.object({
  ...eventFields,
  ...videoFields,
  /** `start` is sent again on resuming from a pause. */
  event: z.enum(PLAYBACK_EVENTS),
  scope: z.enum(['movie', 'episode']),
  positionMs: z.number().min(0),
  /** Absent when unknown: progress is then unknown, not zero. */
  durationMs: z.number().positive().optional(),
  /** Whether playback passed the instance's played threshold. */
  played: z.boolean().optional(),
});

export const MarkEventSchema = z.object({
  ...eventFields,
  ...videoFields,
  event: z.enum(MARK_EVENTS),
  scope: z.enum(['movie', 'episode']),
});

export const BulkMarkEventSchema = z.object({
  ...eventFields,
  event: z.enum(MARK_EVENTS),
  scope: z.enum(['series', 'season']),
  /** The season's number for a `season` mark, otherwise `null`. */
  season: NumberingSchema,
  /** Every video the mark changed, in the meta's order. Write these, not the show. */
  videos: z.array(z.object(videoFields)),
  /** A mark over more than 500 videos is split into parts, each a whole event. */
  part: z.number().int().min(1),
  parts: z.number().int().min(1),
});

export const ListEventSchema = z.object({
  ...eventFields,
  event: z.enum(LIST_EVENTS),
  scope: z.enum(['movie', 'series']),
});

export const RatingEventSchema = z.object({
  ...eventFields,
  event: z.enum(RATING_EVENTS),
  scope: z.enum(['movie', 'series', 'season', 'episode']),
  /** For an episode. */
  videoId: z.string().min(1).optional(),
  season: NumberingSchema,
  episode: NumberingSchema,
  /** 0 to 10, with any decimals the user gave. Absent on `unrated`. */
  rating: z.number().min(0).max(10).optional(),
});

export const WatchStateEventSchema = z.union([
  PlaybackEventSchema,
  MarkEventSchema,
  BulkMarkEventSchema,
  ListEventSchema,
  RatingEventSchema,
]);

export type PlaybackEvent = z.output<typeof PlaybackEventSchema>;
export type MarkEvent = z.output<typeof MarkEventSchema>;
export type BulkMarkEvent = z.output<typeof BulkMarkEventSchema>;
export type ListEvent = z.output<typeof ListEventSchema>;
export type RatingEvent = z.output<typeof RatingEventSchema>;
export type WatchStateEvent = z.output<typeof WatchStateEventSchema>;

export const PullItemSchema = z.object({
  type: ContentTypeSchema.optional(),
  metaId: z.string().min(1),
  videoId: z.string().min(1),
  /** `null` means absolute numbering, not season 1. */
  season: NumberingSchema,
  episode: NumberingSchema,
  /** Send this or `progressPercent`, or both. */
  positionMs: z.number().min(0).optional(),
  durationMs: z.number().positive().optional(),
  progressPercent: z.number().min(0).max(100).optional(),
  played: z.boolean().optional(),
  /** Unix seconds. */
  at: z.number().optional(),
});

export const NextUpEntrySchema = z.object({
  type: ContentTypeSchema.optional(),
  metaId: z.string().min(1),
  videoId: z.string().min(1),
  season: NumberingSchema,
  episode: NumberingSchema,
  /** Unix seconds: when the show was last watched. */
  at: z.number().optional(),
  /** Unix seconds: when this episode airs. */
  airsAt: z.number().nullish(),
});

export const WatchedSchema = z.object({
  /** Base ids of finished films. */
  movies: z.array(z.string()).optional(),
  /** Video ids of finished episodes. */
  episodes: z.array(z.string()).optional(),
  /** Keyed by every id the show answers to; `0` for a total you do not know. */
  counts: z
    .record(
      z.string(),
      z.object({
        watched: CountSchema,
        total: CountSchema,
        at: z.number().optional(),
      })
    )
    .optional(),
  nextUp: z.array(NextUpEntrySchema).optional(),
  /** Every id of every dropped show. */
  dropped: z.array(z.string()).optional(),
});

const KindSchema = z.enum(['movie', 'series']);

export const WatchlistEntrySchema = z.object({
  type: ContentTypeSchema,
  /** Needed when `type` does not say which, such as `anime`. */
  kind: KindSchema.optional(),
  metaId: z.string().min(1),
  /** Unix seconds: when it was added. */
  at: z.number().optional(),
});

export const RatingEntrySchema = z.object({
  type: ContentTypeSchema,
  kind: KindSchema.optional(),
  metaId: z.string().min(1),
  /** Rates that episode when it differs from `metaId`. */
  videoId: z.string().min(1).optional(),
  /** Rates that season, without a `videoId`. */
  season: NumberingSchema,
  rating: z.number().min(0).max(10),
  at: z.number().optional(),
});

export const PullAnswerSchema = z.object({
  version: z.string().optional(),
  items: z.array(PullItemSchema).optional(),
  watched: WatchedSchema.optional(),
  watchlist: z.array(WatchlistEntrySchema).optional(),
  ratings: z.array(RatingEntrySchema).optional(),
});

export type PullItem = z.input<typeof PullItemSchema>;
export type NextUpEntry = z.input<typeof NextUpEntrySchema>;
export type Watched = z.input<typeof WatchedSchema>;
export type WatchlistEntry = z.input<typeof WatchlistEntrySchema>;
export type RatingEntry = z.input<typeof RatingEntrySchema>;
export type PullAnswer = z.input<typeof PullAnswerSchema>;
