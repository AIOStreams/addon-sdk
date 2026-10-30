import { z } from 'zod';
import { configReader, type ConfigDefinition } from './config.js';
import type { Theme } from './configure-page.js';
import { AddonDefinitionError } from './errors.js';
import type { Logger } from './log.js';
import { createRouter, type HandleOptions } from './router.js';
import type { ContentType } from './schemas/common.js';
import {
  ManifestSchema,
  type Manifest,
  type ResourceName,
} from './schemas/manifest.js';
import type {
  AddonCatalogResponse,
  CatalogExtra,
  CatalogResponse,
  LibraryExtra,
  MetaResponse,
  PlayerExtra,
  StreamResponse,
  SubtitlesExtra,
  SubtitlesResponse,
} from './schemas/requests.js';
import type {
  PullItem,
  RatingEntry,
  Watched,
  WatchlistEntry,
  WatchStateEvent,
} from './schemas/watch-state.js';

export type Awaitable<T> = T | Promise<T>;

export interface HandlerContext<Config> {
  config: Config;
  request: Request;
  /** Tagged with this request's id and what it asked for. */
  log: Logger;
}

export interface ResourceArgs<Config> extends HandlerContext<Config> {
  type: ContentType;
  id: string;
}

export interface CatalogArgs<Config> extends ResourceArgs<Config> {
  extra: CatalogExtra;
  /** Every extra value, for a catalog that lets several options be picked. */
  rawExtra: URLSearchParams;
}

export interface SubtitlesArgs<Config> extends ResourceArgs<Config> {
  extra: SubtitlesExtra;
}

export interface PlayerArgs<Config> extends ResourceArgs<Config>, PlayerExtra {}

export interface LibraryArgs<Config>
  extends ResourceArgs<Config>, LibraryExtra {}

export interface WatchStatePushArgs<Config> extends HandlerContext<Config> {
  event: WatchStateEvent;
  /** Set only when the manifest declares `viewers`. */
  viewer?: string;
}

export interface WatchStatePullArgs<Config> extends HandlerContext<Config> {
  /** The `version` of your last answer this reader stored. */
  since?: string;
  viewer?: string;
}

/** A value, or a function only called when the value is needed. */
export type Lazy<T> = T | (() => Awaitable<T | undefined>);

export interface PullResult {
  /** Must change whenever `watched` does. */
  version?: string;
  items?: PullItem[];
  /** Skipped when `since` matches `version`. A throw or `undefined` sends nothing, never an empty list. */
  watched?: Lazy<Watched>;
  watchlist?: Lazy<WatchlistEntry[]>;
  ratings?: Lazy<RatingEntry[]>;
}

export interface Redirect {
  redirect: string;
}

export interface AddonDefinition<Config> {
  manifest: Manifest | ((config: NoInfer<Config> | undefined) => Manifest);
  /** A schema for the configuration in the addon's URL, or options with one. */
  config?: ConfigDefinition<Config>;
  catalog?: (
    args: CatalogArgs<NoInfer<Config>>
  ) => Awaitable<CatalogResponse | Redirect>;
  /** Answer `null` for a title you do not have. */
  meta?: (
    args: ResourceArgs<NoInfer<Config>>
  ) => Awaitable<MetaResponse | Redirect | null>;
  stream?: (
    args: ResourceArgs<NoInfer<Config>>
  ) => Awaitable<StreamResponse | Redirect>;
  subtitles?: (
    args: SubtitlesArgs<NoInfer<Config>>
  ) => Awaitable<SubtitlesResponse | Redirect>;
  addonCatalog?: (
    args: ResourceArgs<NoInfer<Config>>
  ) => Awaitable<AddonCatalogResponse | Redirect>;
  /** Playback in the client's player. */
  player?: (args: PlayerArgs<NoInfer<Config>>) => Awaitable<void>;
  /** Library changes and watched marks in the client. */
  library?: (args: LibraryArgs<NoInfer<Config>>) => Awaitable<void>;
  watchState?: {
    push?: (args: WatchStatePushArgs<NoInfer<Config>>) => Awaitable<void>;
    pull?: (args: WatchStatePullArgs<NoInfer<Config>>) => Awaitable<PullResult>;
    /** How many event ids are remembered to drop repeats; 0 turns it off. */
    dedupe?: number;
  };
  /**
   * The page at `/configure`, which `/` leads to; a string is sent as HTML.
   * Without it, a page is built from the config schema; `false` serves none.
   */
  configure?:
    | false
    | ((args: {
        config: NoInfer<Config> | undefined;
        request: Request;
        log: Logger;
        /** The address to install with this configuration, on the address the page was opened at. */
        manifestUrl: (config: NoInfer<Config>) => Promise<string>;
      }) => Awaitable<Response | string>);
  /** Colours the generated configure page. */
  theme?: Theme;
  /** Checks responses against what clients accept: `warn` reports problems, `strict` fails the request. */
  validation?: 'warn' | 'strict' | 'off';
}

export interface Addon<Config> {
  /** `null` for a path that is not the addon's, so it can sit among other routes. */
  handle(request: Request, options?: HandleOptions): Promise<Response | null>;
  /** Answers every request, with a 404 for paths that are not the addon's. */
  fetch(request: Request): Promise<Response>;
  manifest(config?: Config): Manifest;
  /** `{base}/{config}/manifest.json`, the address to install. */
  manifestUrl(base: string | URL, config?: Config): Promise<string>;
}

const HANDLED_BY: Record<ResourceName, (d: AddonDefinition<any>) => unknown> = {
  catalog: (d) => d.catalog,
  meta: (d) => d.meta,
  stream: (d) => d.stream,
  subtitles: (d) => d.subtitles,
  addon_catalog: (d) => d.addonCatalog,
  player: (d) => d.player,
  library: (d) => d.library,
  watch_state: (d) => d.watchState?.push ?? d.watchState?.pull,
};

export function declaredResources(manifest: Manifest): Set<ResourceName> {
  return new Set(
    manifest.resources.map((resource) =>
      typeof resource === 'string' ? resource : resource.name
    )
  );
}

function checkManifest(
  manifest: Manifest,
  definition: AddonDefinition<any>,
  everyHandlerUsed: boolean
): Manifest {
  const parsed = ManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    throw new AddonDefinitionError(
      `Invalid manifest:\n${z.prettifyError(parsed.error)}`
    );
  }
  const declared = declaredResources(manifest);
  const problems: string[] = [];
  for (const resource of declared) {
    if (!HANDLED_BY[resource](definition)) {
      problems.push(`resources lists "${resource}" but it has no handler`);
    }
  }
  if (everyHandlerUsed) {
    for (const [resource, handler] of Object.entries(HANDLED_BY)) {
      if (handler(definition) && !declared.has(resource as ResourceName)) {
        problems.push(
          `there is a ${resource} handler but resources does not list "${resource}"`
        );
      }
    }
  }
  if (manifest.catalogs?.length && !declared.has('catalog')) {
    problems.push('catalogs are listed but resources does not list "catalog"');
  }
  const watchState = manifest.watchState;
  if (declared.has('watch_state') !== !!watchState) {
    problems.push(
      '"watch_state" in resources and the watchState block go together'
    );
  }
  if (watchState?.push && !definition.watchState?.push) {
    problems.push('watchState.push is declared but there is no push handler');
  }
  if (watchState?.pull && !definition.watchState?.pull) {
    problems.push('watchState.pull is declared but there is no pull handler');
  }
  if (problems.length) {
    throw new AddonDefinitionError(
      `Manifest "${manifest.id}": ${problems.join('; ')}`
    );
  }
  return manifest;
}

export function defineAddon<Config = undefined>(
  definition: AddonDefinition<Config>
): Addon<Config> {
  const source = definition.manifest;
  const manifestFor =
    typeof source === 'function'
      ? (config: Config | undefined) =>
          checkManifest(source(config), definition, false)
      : (
          (manifest: Manifest) => () =>
            manifest
        )(checkManifest(source, definition, true));

  const config = definition.config
    ? configReader(definition.config)
    : undefined;
  async function manifestUrl(base: string | URL, value?: Config) {
    const root = String(base).replace(/\/+$/, '');
    const segment =
      config && value !== undefined ? `/${await config.write(value)}` : '';
    return `${root}${segment}/manifest.json`;
  }
  const handle = createRouter({ definition, config, manifestFor, manifestUrl });

  return {
    handle,
    fetch: async (request) =>
      (await handle(request)) ??
      Response.json({ error: 'Not found' }, { status: 404 }),
    manifest: (value) => manifestFor(value),
    manifestUrl,
  };
}
