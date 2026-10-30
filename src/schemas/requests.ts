import { z } from 'zod';
import { CountSchema } from './common.js';
import { AddonDescriptorSchema } from './manifest.js';
import { MetaPreviewSchema, MetaSchema } from './meta.js';
import { StreamSchema } from './stream.js';
import { SubtitleSchema } from './subtitle.js';

const countParam = z.coerce.number().int().min(0);

export const CatalogExtraSchema = z.looseObject({
  search: z.string().optional(),
  genre: z.string().optional(),
  /** How many entries to skip, for the next page. */
  skip: countParam.optional(),
  /** A programme guide's day. */
  date: z.string().optional(),
  /** The id of the title to find titles like. */
  similar: z.string().optional(),
});

export const SubtitlesExtraSchema = z.looseObject({
  /** The OpenSubtitles hash of the video. */
  videoHash: z.string().optional(),
  /** In bytes. */
  videoSize: countParam.optional(),
  filename: z.string().optional(),
});

export const PlayerExtraSchema = z.object({
  /** `start` is sent again on resuming and on seeking while playing. */
  action: z.enum(['start', 'pause', 'stop']),
  /** Milliseconds. */
  currentTime: z.coerce.number().min(0),
  /** Milliseconds; `undefined` while unknown. */
  duration: z.coerce
    .number()
    .min(0)
    .optional()
    .transform((ms) => (ms ? ms : undefined)),
});

export const LibraryExtraSchema = z
  .object({
    action: z.enum(['libraryAdd', 'libraryRemove', 'watched', 'unwatched']),
    videoId: z.string().optional(),
  })
  .transform(({ action, videoId }) => ({
    action,
    /** The videos whose watched state changed; empty when the whole title was marked. */
    videoIds: videoId ? videoId.split(',').filter(Boolean) : [],
  }));

export type CatalogExtra = z.output<typeof CatalogExtraSchema>;
export type SubtitlesExtra = z.output<typeof SubtitlesExtraSchema>;
export type PlayerExtra = z.output<typeof PlayerExtraSchema>;
export type LibraryExtra = z.output<typeof LibraryExtraSchema>;

export const CacheHintsSchema = z.object({
  /** Seconds a response may be cached. */
  cacheMaxAge: CountSchema.optional(),
  /** Seconds a stale response may be served while it is refreshed. */
  staleRevalidate: CountSchema.optional(),
  /** Seconds a stale response may be served when refreshing fails. */
  staleError: CountSchema.optional(),
});

export type CacheHints = z.input<typeof CacheHintsSchema>;

export const CatalogResponseSchema = CacheHintsSchema.extend({
  metas: z.array(MetaPreviewSchema),
});
export const MetaResponseSchema = CacheHintsSchema.extend({
  meta: MetaSchema,
});
export const StreamResponseSchema = CacheHintsSchema.extend({
  streams: z.array(StreamSchema),
});
export const SubtitlesResponseSchema = CacheHintsSchema.extend({
  subtitles: z.array(SubtitleSchema),
});
export const AddonCatalogResponseSchema = CacheHintsSchema.extend({
  addons: z.array(AddonDescriptorSchema),
});

export type CatalogResponse = z.input<typeof CatalogResponseSchema>;
export type MetaResponse = z.input<typeof MetaResponseSchema>;
export type StreamResponse = z.input<typeof StreamResponseSchema>;
export type SubtitlesResponse = z.input<typeof SubtitlesResponseSchema>;
export type AddonCatalogResponse = z.input<typeof AddonCatalogResponseSchema>;
