import { z } from 'zod';
import { ContentTypeSchema, UrlSchema } from './common.js';
import { WATCH_STATE_EVENTS } from './watch-state.js';

export const RESOURCE_NAMES = [
  'catalog',
  'meta',
  'stream',
  'subtitles',
  'addon_catalog',
  'player',
  'library',
  'watch_state',
] as const;

export type ResourceName = (typeof RESOURCE_NAMES)[number];

export const ManifestResourceSchema = z.union([
  z.enum(RESOURCE_NAMES),
  z.object({
    name: z.enum(RESOURCE_NAMES),
    types: z.array(ContentTypeSchema).optional(),
    idPrefixes: z.array(z.string()).optional(),
  }),
]);

export type ExtraName =
  'search' | 'genre' | 'skip' | 'date' | 'similar' | (string & {});

export const ManifestExtraSchema = z.object({
  name: z.string().min(1) as unknown as z.ZodType<ExtraName, ExtraName>,
  /** A required extra with no `options` keeps the catalog off home screens. */
  isRequired: z.boolean().optional(),
  options: z.array(z.string()).optional(),
  /** How many `options` may be picked at once; 1 by default. */
  optionsLimit: z.number().int().min(1).optional(),
});

export const ManifestCatalogSchema = z.object({
  type: ContentTypeSchema,
  id: z.string().min(1),
  name: z.string().min(1),
  extra: z.array(ManifestExtraSchema).optional(),
  /** The library's tile in Jellyfin clients. */
  poster: UrlSchema.optional(),
  /** The library's backdrop in Jellyfin clients. */
  background: UrlSchema.optional(),
  /** For a `similar` catalog: the ids you understand. */
  idPrefixes: z.array(z.string()).optional(),
});

export const ManifestBehaviorHintsSchema = z.object({
  adult: z.boolean().optional(),
  p2p: z.boolean().optional(),
  /** Shows a Configure button that opens `/configure`. */
  configurable: z.boolean().optional(),
  /** Asks for configuration before installing; left out of a configured addon's manifest. */
  configurationRequired: z.boolean().optional(),
  /** A `tv` catalog with the `date` extra is a programme guide. */
  epgProvider: z.boolean().optional(),
});

export const WatchStateManifestSchema = z.object({
  version: z.literal(2),
  /** One configuration serves several people, told apart by `viewer`. */
  viewers: z.boolean().optional(),
  push: z
    .object({
      /** Omit for every playback event; the others are sent only when listed. */
      events: z.array(z.enum(WATCH_STATE_EVENTS)).optional(),
      /** A whole show or season marked at once arrives as one request. */
      bulk: z.boolean().optional(),
    })
    .optional(),
  pull: z
    .object({
      items: z.boolean().optional(),
      watched: z.boolean().optional(),
      watchlist: z.boolean().optional(),
      ratings: z.boolean().optional(),
      /** How long an answer may be reused. */
      ttlSeconds: z.number().int().min(0).optional(),
    })
    .optional(),
});

/** Strict semantic versioning: a manifest whose version is not is refused. */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export const ManifestSchema = z.object({
  /** Dot-separated, e.g. `com.example.addon`. */
  id: z.string().min(1),
  version: z.string().regex(SEMVER, 'expected a semantic version, e.g. 1.0.0'),
  name: z.string().min(1),
  description: z.string().optional(),
  logo: z.string().optional(),
  background: z.string().optional(),
  contactEmail: z.string().optional(),
  types: z.array(ContentTypeSchema),
  resources: z.array(ManifestResourceSchema).min(1),
  idPrefixes: z.array(z.string()).optional(),
  catalogs: z.array(ManifestCatalogSchema).optional(),
  addonCatalogs: z
    .array(
      z.object({
        type: ContentTypeSchema,
        id: z.string().min(1),
        name: z.string().min(1),
      })
    )
    .optional(),
  behaviorHints: ManifestBehaviorHintsSchema.optional(),
  /** Signs the addon for the stremio-addons.net listing. */
  stremioAddonsConfig: z
    .object({ issuer: z.string().min(1), signature: z.string().min(1) })
    .optional(),
  watchState: WatchStateManifestSchema.optional(),
});

export const AddonDescriptorSchema = z.object({
  transportName: z.literal('http'),
  /** The addon's `manifest.json` address. */
  transportUrl: UrlSchema,
  manifest: ManifestSchema,
});

export type ManifestResource = z.input<typeof ManifestResourceSchema>;
export type ManifestExtra = z.input<typeof ManifestExtraSchema>;
export type ManifestCatalog = z.input<typeof ManifestCatalogSchema>;
export type ManifestBehaviorHints = z.input<typeof ManifestBehaviorHintsSchema>;
export type WatchStateManifest = z.input<typeof WatchStateManifestSchema>;
export type Manifest = z.input<typeof ManifestSchema>;
export type AddonDescriptor = z.input<typeof AddonDescriptorSchema>;
