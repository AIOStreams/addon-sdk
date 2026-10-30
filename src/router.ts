import { z } from 'zod';
import type { AddonDefinition, Lazy } from './addon.js';
import type { ConfigReader } from './config.js';
import {
  configurePage,
  keepSecrets,
  withoutSecrets,
} from './configure-page.js';
import { AddonError, ResponseValidationError } from './errors.js';
import { declaredResources } from './addon.js';
import { createLogger, type Logger } from './log.js';
import type { Manifest } from './schemas/manifest.js';
import {
  AddonCatalogResponseSchema,
  CatalogExtraSchema,
  CatalogResponseSchema,
  LibraryExtraSchema,
  MetaResponseSchema,
  PlayerExtraSchema,
  StreamResponseSchema,
  SubtitlesExtraSchema,
  SubtitlesResponseSchema,
} from './schemas/requests.js';
import {
  LIST_EVENTS,
  MARK_EVENTS,
  PLAYBACK_EVENTS,
  PullAnswerSchema,
  WatchStateEventSchema,
} from './schemas/watch-state.js';

/** Larger than any event, a bulk mark of 500 videos included. */
export const MAX_BODY_BYTES = 1024 * 1024;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS',
  'access-control-allow-headers': '*',
};

const ROUTE_HEADS = new Set([
  'manifest.json',
  'configure',
  'catalog',
  'meta',
  'stream',
  'subtitles',
  'addon_catalog',
  'player',
  'library',
  'watch_state',
]);

const RESPONSE_SCHEMAS = {
  catalog: CatalogResponseSchema,
  meta: MetaResponseSchema,
  stream: StreamResponseSchema,
  subtitles: SubtitlesResponseSchema,
  addon_catalog: AddonCatalogResponseSchema,
  watch_state: PullAnswerSchema,
} as const;

const CACHE_HINTS = {
  cacheMaxAge: 'max-age',
  staleRevalidate: 'stale-while-revalidate',
  staleError: 'stale-if-error',
} as const;

const REPORTED_LIMIT = 200;

function json(body: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      'content-type': 'application/json; charset=utf-8',
      ...headers,
    },
  });
}

function html(page: string) {
  return new Response(page, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function errorResponse(error: AddonError) {
  return json(
    { error: error.message },
    error.status,
    error.retryAfter ? { 'retry-after': String(error.retryAfter) } : {}
  );
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new AddonError(400, 'Malformed path');
  }
}

function parsed<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new AddonError(
    400,
    `Invalid ${what}: ${z.prettifyError(result.error)}`
  );
}

/** Moves cache hints into `Cache-Control`. */
function withCacheHints(body: Record<string, unknown>) {
  const directives: string[] = [];
  const rest = { ...body };
  for (const [field, directive] of Object.entries(CACHE_HINTS)) {
    const value = rest[field];
    delete rest[field];
    if (typeof value === 'number') directives.push(`${directive}=${value}`);
  }
  return json(
    rest,
    200,
    directives.length
      ? { 'cache-control': `${directives.join(', ')}, public` }
      : {}
  );
}

async function readBody(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new AddonError(413, 'Body too large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** Senders of the first protocol version left `scope` out. */
function withScope(body: unknown, pathType: string): unknown {
  if (!body || typeof body !== 'object' || 'scope' in body) return body;
  const event = body as Record<string, unknown>;
  const name = event.event as string;
  const isFilm = pathType === 'movie';
  let scope: string | undefined;
  if (
    (PLAYBACK_EVENTS as readonly string[]).includes(name) ||
    (MARK_EVENTS as readonly string[]).includes(name)
  ) {
    scope = isFilm ? 'movie' : 'episode';
  } else if ((LIST_EVENTS as readonly string[]).includes(name)) {
    scope = isFilm ? 'movie' : 'series';
  }
  return scope ? { ...event, scope } : body;
}

async function resolveLazy<T>(
  value: Lazy<T> | undefined,
  part: string,
  log: Logger
): Promise<T | undefined> {
  if (typeof value !== 'function') return value;
  try {
    return await (value as () => Promise<T | undefined>)();
  } catch (err) {
    log.warn({ err, part }, 'left a part of the answer out: reading it failed');
    return undefined;
  }
}

/** The configuration segment can hold credentials, so it is never logged. */
function loggedPath(url: URL): string {
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length > 1 && !ROUTE_HEADS.has(segments[0]))
    segments[0] = '{config}';
  return `/${segments.join('/')}`;
}

/** A bounded set, oldest entries leaving first. */
class RecentSet {
  private readonly entries = new Set<string>();
  constructor(private readonly size: number) {}
  has(key: string) {
    return this.entries.has(key);
  }
  add(key: string) {
    this.entries.add(key);
    if (this.entries.size > this.size) {
      this.entries.delete(this.entries.values().next().value!);
    }
  }
}

interface RouterOptions {
  definition: AddonDefinition<any>;
  config: ConfigReader<any> | undefined;
  manifestFor: (config: any) => Manifest;
  manifestUrl: (base: string, config?: any) => Promise<string>;
}

export function createRouter({
  definition,
  config,
  manifestFor,
  manifestUrl,
}: RouterOptions) {
  const logger = createLogger('addon');
  const validation = definition.validation ?? 'warn';
  const reported = new Set<string>();
  const seenEvents = new RecentSet(definition.watchState?.dedupe ?? 10_000);
  const dedupe = (definition.watchState?.dedupe ?? 10_000) > 0;

  function checkResponse(
    resource: keyof typeof RESPONSE_SCHEMAS,
    body: unknown,
    log: Logger
  ) {
    if (validation === 'off') return;
    const result = RESPONSE_SCHEMAS[resource].safeParse(body);
    if (result.success) return;
    const issues = z.prettifyError(result.error);
    if (validation === 'strict') {
      const error = new ResponseValidationError(resource, issues);
      throw new AddonError(500, error.message, { cause: error });
    }
    const key = `${resource}\n${issues}`;
    if (reported.has(key)) return;
    if (reported.size < REPORTED_LIMIT) reported.add(key);
    log.warn({ resource, issues }, 'sent a response clients would reject');
  }

  // Without a config, the page shows the addon and its link with no fields.
  const formSchema = () =>
    config ? config.jsonSchema() : { type: 'object', properties: {} };

  const hasConfigurePage = () =>
    typeof definition.configure === 'function' ||
    (definition.configure !== false && !!formSchema());

  async function route(
    request: Request,
    url: URL,
    log: Logger
  ): Promise<Response | null> {
    let segments = url.pathname.split('/').filter(Boolean);
    let configSegment: string | undefined;
    if (segments.length > 1 && !ROUTE_HEADS.has(segments[0])) {
      if (!config) return null;
      configSegment = segments[0];
      segments = segments.slice(1);
    }
    const [head, ...rest] = segments;
    if (!head && !configSegment && hasConfigurePage()) {
      return new Response(null, {
        status: 302,
        headers: { ...CORS, location: '/configure' },
      });
    }
    if (!head || !ROUTE_HEADS.has(head)) return null;

    const method = request.method === 'HEAD' ? 'GET' : request.method;
    if (method === 'OPTIONS')
      return new Response(null, { status: 204, headers: CORS });

    if (head === 'manifest.json' && !rest.length) {
      if (method !== 'GET') throw new AddonError(405, 'Method not allowed');
      const value =
        config && configSegment !== undefined
          ? await config.read(configSegment)
          : await config?.read(undefined).catch(() => undefined);
      const manifest = manifestFor(value);
      const served = { catalogs: [], ...manifest };
      if (
        configSegment !== undefined &&
        served.behaviorHints?.configurationRequired
      ) {
        served.behaviorHints = {
          ...served.behaviorHints,
          configurationRequired: false,
        };
      }
      return json(served);
    }

    if (head === 'configure' && !rest.length) {
      if (definition.configure === false) return null;
      if (definition.configure) {
        // A broken configuration still opens the page, to be made again.
        const value =
          configSegment === undefined
            ? undefined
            : await config?.read(configSegment).catch(() => undefined);
        const page = await definition.configure({
          config: value,
          request,
          log,
          manifestUrl: (next) => manifestUrl(url.origin, next),
        });
        return typeof page === 'string' ? html(page) : page;
      }
      const schema = formSchema();
      if (!schema) return null;
      const current =
        config && configSegment !== undefined
          ? await config.decode(configSegment)
          : undefined;

      if (method === 'GET') {
        const shown = withoutSecrets(schema, current);
        const manifest = manifestFor(
          current === undefined
            ? undefined
            : await config!.read(configSegment).catch(() => undefined)
        );
        return html(
          configurePage({
            manifest,
            schema,
            values: shown.values,
            kept: shown.kept,
            editing: current !== undefined,
            theme: definition.theme,
          })
        );
      }
      if (method !== 'POST') throw new AddonError(405, 'Method not allowed');
      if (!config) return json({ manifestUrl: await manifestUrl(url.origin) });
      let body: { values?: unknown };
      try {
        body = JSON.parse(await readBody(request));
      } catch (error) {
        if (error instanceof AddonError) throw error;
        throw new AddonError(400, 'Invalid JSON');
      }
      const checked = await config.check(
        keepSecrets(schema, body.values ?? {}, current)
      );
      if ('issues' in checked) {
        log.debug(
          { issues: checked.issues.length },
          'the configure form had problems'
        );
        return json(
          { error: 'Check the highlighted fields', issues: checked.issues },
          400
        );
      }
      return json({
        manifestUrl: await manifestUrl(url.origin, checked.value),
      });
    }

    const last = rest.at(-1);
    if (!last?.endsWith('.json')) return null;
    const raw = [...rest.slice(0, -1), last.slice(0, -'.json'.length)];
    const parts = raw.map(decodeSegment);

    const value = await config?.read(configSegment);
    const manifest = manifestFor(value);
    const declared = declaredResources(manifest);
    if (!declared.has(head as never)) throw new AddonError(404, 'Not found');

    if (head === 'watch_state') {
      const viewer = url.searchParams.get('viewer') ?? undefined;
      if (parts.length === 1 && parts[0] === 'pull') {
        const pull = definition.watchState?.pull;
        if (!pull || !manifest.watchState?.pull)
          throw new AddonError(404, 'Not found');
        if (method !== 'GET') throw new AddonError(405, 'Method not allowed');
        const since = url.searchParams.get('since') ?? undefined;
        const scoped = log.child({ resource: 'watch_state', viewer });
        const result = await pull({
          config: value,
          request,
          log: scoped,
          since,
          viewer,
        });
        const answer: Record<string, unknown> = {};
        if (result.items) answer.items = result.items;
        if (result.version !== undefined && since === result.version) {
          answer.version = result.version;
        } else {
          const watched = await resolveLazy(result.watched, 'watched', scoped);
          // A version without the block it describes would gate it out for good.
          if (watched) {
            answer.version = result.version;
            answer.watched = watched;
          }
        }
        const watchlist = await resolveLazy(
          result.watchlist,
          'watchlist',
          scoped
        );
        if (watchlist) answer.watchlist = watchlist;
        const ratings = await resolveLazy(result.ratings, 'ratings', scoped);
        if (ratings) answer.ratings = ratings;
        checkResponse('watch_state', answer, scoped);
        return json(answer, 200, { 'cache-control': 'no-store' });
      }
      if (parts.length === 3 && parts[0] === 'push') {
        const push = definition.watchState?.push;
        if (!push || !manifest.watchState?.push)
          throw new AddonError(404, 'Not found');
        if (method !== 'POST') throw new AddonError(405, 'Method not allowed');
        let body: unknown;
        try {
          body = JSON.parse(await readBody(request));
        } catch (error) {
          if (error instanceof AddonError) throw error;
          throw new AddonError(400, 'Invalid JSON');
        }
        const event = parsed(
          WatchStateEventSchema,
          withScope(body, parts[1]),
          'event'
        );
        const key = `${configSegment ?? ''}|${viewer ?? ''}|${event.id}`;
        const scoped = log.child({
          resource: 'watch_state',
          event: event.event,
          viewer,
        });
        if (dedupe && seenEvents.has(key)) {
          scoped.debug({ id: event.id }, 'skipped an event already applied');
          return new Response(null, { status: 204, headers: CORS });
        }
        await push({ config: value, request, log: scoped, event, viewer });
        if (dedupe) seenEvents.add(key);
        return new Response(null, { status: 204, headers: CORS });
      }
      return null;
    }

    if (parts.length !== 2 && parts.length !== 3) return null;
    if (method !== 'GET') throw new AddonError(405, 'Method not allowed');
    const [type, id] = parts;
    // Extras are decoded once, here: decoding the segment first would split values holding `&`.
    const rawExtra = new URLSearchParams(raw[2] ?? '');
    const extra = Object.fromEntries(rawExtra);
    const scoped = log.child({ resource: head, type, id });
    const base = { config: value, request, log: scoped, type, id };

    let body: unknown;
    switch (head) {
      case 'catalog':
        body = await definition.catalog!({
          ...base,
          extra: parsed(CatalogExtraSchema, extra, 'extra'),
          rawExtra,
        });
        break;
      case 'meta':
        body = await definition.meta!(base);
        if (body === null) throw new AddonError(404, 'Not found');
        break;
      case 'stream':
        body = await definition.stream!(base);
        break;
      case 'subtitles':
        body = await definition.subtitles!({
          ...base,
          extra: parsed(SubtitlesExtraSchema, extra, 'extra'),
        });
        break;
      case 'addon_catalog':
        body = await definition.addonCatalog!(base);
        break;
      case 'player':
        await definition.player!({
          ...base,
          ...parsed(PlayerExtraSchema, extra, 'extra'),
        });
        return json({});
      case 'library':
        await definition.library!({
          ...base,
          ...parsed(LibraryExtraSchema, extra, 'extra'),
        });
        return json({});
      default:
        return null;
    }
    const result = body as Record<string, unknown>;
    if (typeof result.redirect === 'string') {
      return new Response(null, {
        status: 307,
        headers: { ...CORS, location: result.redirect },
      });
    }
    checkResponse(head as keyof typeof RESPONSE_SCHEMAS, result, scoped);
    return withCacheHints(result);
  }

  return async function handle(request: Request): Promise<Response | null> {
    const started = Date.now();
    const url = new URL(request.url);
    const log = logger.child({ rid: crypto.randomUUID().slice(0, 8) });
    const fields = (status: number) => ({
      method: request.method,
      path: loggedPath(url),
      status,
      ms: Date.now() - started,
    });
    let response: Response | null;
    try {
      response = await route(request, url, log);
    } catch (err) {
      if (!(err instanceof AddonError)) {
        log.error({ ...fields(500), err }, 'a handler failed');
        return json({ error: 'Internal error' }, 500);
      }
      if (err.status >= 500)
        log.error(
          { ...fields(err.status), err: err.cause ?? err },
          err.message
        );
      else
        log.debug(
          { ...fields(err.status), reason: err.message },
          'refused a request'
        );
      return errorResponse(err);
    }
    if (response) log.debug(fields(response.status), 'answered a request');
    return response;
  };
}
