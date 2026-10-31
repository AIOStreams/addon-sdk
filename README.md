# @aiostreams/addon-sdk

Build addons for [AIOStreams](https://github.com/Viren070/AIOStreams) and Stremio in TypeScript. The SDK covers every field of the [AIOStreams addon protocol](https://docs.aiostreams.viren070.me/reference/addon-protocol): extended metadata, people, collections, archive and usenet sources, and watch state. It also covers the Stremio fields those build on.

It works with web-standard `Request` and `Response` objects, so one addon runs unchanged on Node, Bun, Deno, Cloudflare Workers and anything else that speaks `fetch`. The SDK handles:

- routing, CORS and cache headers
- configuration in the URL, optionally encrypted
- a configure page generated from your config schema
- environment variables
- structured logging
- checking responses against what clients accept

```sh
npm install @aiostreams/addon-sdk zod
```

Requires Node 22 or newer, Bun, Deno, or a Workers runtime. [zod](https://zod.dev) 4 is used in the examples; any [Standard Schema](https://standardschema.dev) library works for configuration and environment variables.

## Quick start

```ts
import { defineAddon } from '@aiostreams/addon-sdk';
import { serve } from '@aiostreams/addon-sdk/node';

const addon = defineAddon({
  manifest: {
    id: 'com.example.hello',
    version: '1.0.0',
    name: 'Hello',
    types: ['movie'],
    idPrefixes: ['tt'],
    resources: ['stream'],
  },
  stream: ({ id }) => {
    if (id !== 'tt1375666') return { streams: [] };
    return {
      streams: [
        {
          name: 'Example\n1080p',
          url: 'https://cdn.example.com/inception.mkv',
        },
      ],
      cacheMaxAge: 3600,
    };
  },
});

await serve(addon); // PORT, or 7000
```

Open `http://localhost:7000` for the addon's page and its link, then add the link to AIOStreams as a custom addon.

Every handler and response is typed from the protocol schemas, so your editor lists each field with what it does. When the definition and its manifest disagree, `defineAddon` throws an `AddonDefinitionError` at startup. Examples: a resource with no handler, a handler the manifest doesn't declare, or catalogs without the `catalog` resource.

## Handlers

| Handler        | Path                                            | Arguments besides `config`, `request`, `log`      | Answer                          |
| -------------- | ----------------------------------------------- | ------------------------------------------------- | ------------------------------- |
| `catalog`      | `/catalog/{type}/{id}/{extra}.json`             | `type`, `id`, `extra`, `rawExtra`                 | `{ metas }`                     |
| `meta`         | `/meta/{type}/{id}.json`                        | `type`, `id`                                      | `{ meta }`, or `null` for a 404 |
| `stream`       | `/stream/{type}/{id}.json`                      | `type`, `id`                                      | `{ streams }`                   |
| `subtitles`    | `/subtitles/{type}/{id}/{extra}.json`           | `type`, `id`, `extra`                             | `{ subtitles }`                 |
| `addonCatalog` | `/addon_catalog/{type}/{id}.json`               | `type`, `id`                                      | `{ addons }`                    |
| `player`       | `/player/{type}/{id}/{extra}.json`              | `type`, `id`, `action`, `currentTime`, `duration` | nothing                         |
| `library`      | `/library/{type}/{id}/{extra}.json`             | `type`, `id`, `action`, `videoIds`                | nothing                         |
| `watchState`   | `/watch_state/push/…`, `/watch_state/pull.json` | see [Watch state](#watch-state)                   |                                 |

Paths and extras are decoded once, in the right order: an id holding `:` or `/` and a search holding `&` all arrive intact. Extras are parsed: `skip` and `videoSize` are numbers, and a bad value is a 400 before your handler runs. `rawExtra` keeps every value as a `URLSearchParams`, for a catalog that lets several options be picked.

Answers can carry cache hints, `cacheMaxAge`, `staleRevalidate` and `staleError` (seconds), which become a `Cache-Control` header. Any resource can answer `{ redirect: url }` for a 307.

### Errors

Throw an `AddonError` to answer with a status and message. `notFound()` is a shorthand for a 404.

When you have nothing for a title, answer an empty list such as `{ streams: [] }` instead. AIOStreams shows any error status in the stream list as a failed addon.

```ts
import { AddonError } from '@aiostreams/addon-sdk';

throw new AddonError(429, 'Upstream is rate limiting us', { retryAfter: 30 });
```

Any other error is answered with a plain 500. The client never sees its message, and the error goes to your logs with its stack and cause.

## Configuration

Give `config` a schema, and each user's settings travel in the first path segment of their addon URL: `/{config}/manifest.json`, `/{config}/stream/…`. Handlers receive the parsed, typed value.

```ts
const addon = defineAddon({
  manifest: {
    /* … */
    behaviorHints: { configurable: true, configurationRequired: true },
  },
  config: z.object({
    apiKey: z.string().min(1).meta({ title: 'API key', writeOnly: true }),
    quality: z.enum(['2160p', '1080p', '720p']).default('1080p'),
  }),
  stream: async ({ id, config }) => ({
    streams: await search(id, config.apiKey, config.quality),
  }),
});
```

- **Without a configuration**, a request gets what the schema makes of `{}`. When that fails, as it does here without an `apiKey`, the request is refused with "This addon needs to be configured".
- **A configured manifest** is served with `configurationRequired: false`, so clients install it straight away.
- **A per-user manifest**: `manifest` can be a function of the configuration, to name the addon after the user's choices or list only the catalogs they picked.
- **`addon.manifestUrl(base, config)`** gives the address to install for a configuration.

By default the configuration is base64url JSON, which anyone holding the URL can read. To encrypt it with AES-GCM, give a secret of at least 32 characters:

```ts
config: { schema: Settings, secret: env.CONFIG_SECRET },
```

Changing the secret invalidates every URL made with the old one. To keep reading the URLs of an addon that already has users, pass your own `encoding: { encode, decode }` instead.

### The configure page

Every addon gets a page at `/configure`, and `/` redirects there. Without a config schema it shows the addon and its install link. With one, it is a form built from the schema's JSON Schema. It is one page with its script and styles inline (about 90 KB), so it needs no static files on any platform. The form handles:

| Schema                                | Field                                          |
| ------------------------------------- | ---------------------------------------------- |
| `z.string()`, `z.url()`, `z.number()` | text and number inputs, with their limits      |
| `z.boolean()`                         | a switch                                       |
| `z.enum([...])`                       | segmented choice, or a menu for long lists     |
| `z.array(z.enum([...]))`              | checkable chips                                |
| `z.array(z.string())`                 | a list you can add to, reorder and remove from |
| `z.array(z.object({...}))`            | a list of grouped fields, reorderable          |
| `z.discriminatedUnion(...)`           | a choice that swaps the fields under it        |
| `z.object({...})`                     | a group                                        |

Lists reorder by dragging the handle or with the arrow buttons, by mouse, touch or keyboard.

`title` and `description` from `.meta()` (or `.describe()`) label each field. Defaults are filled in, and problems are shown under the field they belong to, list rows included.

Mark credentials with `writeOnly: true`. Their values are never sent back to the browser. When a user reconfigures, a secret field shows as saved, and leaving it blank keeps the saved value. Each entry of a reordered list keeps its own secret.

The page takes its name, logo and description from your manifest, and shows its `background` image behind the header. Set an accent colour with `theme: { accent: '#2563eb' }`. The page's main button copies the install link, ready to paste into AIOStreams. An **Install in Stremio** button is added when the addon serves something Stremio can use, which is any resource but watch state.

Titles, descriptions and the manifest's description can use basic Markdown, the same that AIOStreams renders in addon text:

| Markdown                                        | Shows                                          |
| ----------------------------------------------- | ---------------------------------------------- |
| `**bold**`, `*italic*`, `~~struck~~`            | emphasis; `_` works too, but not inside a word |
| `` `code` ``                                    | code                                           |
| `[text](https://…)`, `<https://…>`, `https://…` | a link, opened in a new tab                    |
| `![alt](https://…)`                             | an image, sized for logos and badges           |
| `- item`, `* item`, `1. item`                   | a list                                         |
| `# Heading` to `### Heading`                    | a heading, in descriptions                     |

A newline is a line break, and a blank line starts a new paragraph. Only `http`, `https` and `mailto` addresses become links. Text is rendered as nodes, never as HTML, so nothing in it can run a script.

`footer` puts Markdown at the foot of the page, for an attribution or links to your docs:

```ts
footer: '[![TMDB](https://example.com/tmdb.svg)](https://www.themoviedb.org) Metadata from TMDB.',
```

To serve your own page instead, return HTML or a `Response` from `configure`. It is given `manifestUrl(config)` to build install links. `configure: false` serves no page and leaves `/` alone.

```ts
configure: async ({ config, manifestUrl }) => renderMyPage(config, await manifestUrl(defaults)),
```

## Environment variables

`defineEnv` reads and checks every variable once, at startup, and reports all the problems together:

```ts
import { defineEnv } from '@aiostreams/addon-sdk';
import { z } from 'zod';

export const env = defineEnv({
  PORT: z.coerce.number().int().default(7000),
  TMDB_KEY: z.string().min(1),
  CONFIG_SECRET: z.string().min(32),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

env.TMDB_KEY; // string
```

```
EnvError: Invalid environment:
  TMDB_KEY: required
  CONFIG_SECRET: Too small: expected string to have >=32 characters
```

- **The `.env` file**: on Node, `.env` is loaded first when it exists, and variables already set win. Pass `{ file: '.env.local' }` for another file, or `{ file: false }` to skip it.
- **Text values**: values arrive as text, so use `z.coerce.number()` or `z.stringbool()` for other types.
- **Empty values**: an empty value counts as unset, so a blank line in `.env` falls back to the default.
- **Platform bindings**: on platforms that pass variables as bindings, read those instead:

```ts
import { env as bindings } from 'cloudflare:workers';
const env = defineEnv(
  { CONFIG_SECRET: z.string().min(32) },
  { source: bindings }
);
```

## Logging

The SDK logs structured entries, as JSON lines by default or as readable coloured lines in a terminal. It writes to the console, which every platform collects, Workers Logs included.

Each handler is given a `log` already tagged with the request's id and what it asked for. Elsewhere, make a logger per part of your addon:

```ts
import { createLogger } from '@aiostreams/addon-sdk';

const log = createLogger('tmdb');

export async function lookup(id: string) {
  const res = await fetch(`https://api.themoviedb.org/3/find/${id}`);
  if (!res.ok) log.warn({ id, status: res.status }, 'lookup failed');
}

stream: async ({ id, log }) => {
  log.debug({ upstream: 'tmdb' }, 'searching');
  // …
},
```

```
12:40:01.218 DEBUG addon searching rid=7958f7bb resource=stream type=movie id=tt1375666 upstream=tmdb
12:40:01.502 WARN  tmdb lookup failed id=tt1375666 status=429
```

Fields come first, then the message, as in pino. Pass an error as `err` to keep its stack and cause, and use `log.child({ ... })` for a logger with more fields bound.

Set the level and format once, at startup. The default level is `info`. The default format is `pretty` in a terminal and `json` everywhere else.

```ts
configureLogging({ level: env.LOG_LEVEL });
```

What the SDK logs itself:

| Level   | Entry                                                                                                    |
| ------- | -------------------------------------------------------------------------------------------------------- |
| `error` | a handler failed, with the error and the request                                                         |
| `warn`  | a response clients would reject, once per problem; a watch state part left out because reading it failed |
| `info`  | where `serve()` is listening                                                                             |
| `debug` | every request with its status and time; refused requests and why; repeated watch state events skipped    |

A request's path is logged with `{config}` in place of the configuration, so credentials never reach your logs.

To send everything to another logger, give it as the `sink`. Anything with pino's `debug`/`info`/`warn`/`error(fields, message)` shape works:

```ts
import pino from 'pino';
configureLogging({ sink: pino() });
```

## Watch state

Addons that keep watch history (trackers, sync services) declare `watch_state`. AIOStreams then sends playback, watched marks, watchlist and ratings changes to `push`, and reads progress and history from `pull`. The [watch state reference](https://docs.aiostreams.viren070.me/reference/addon-protocol/watch-state) covers the protocol. The SDK handles the parts that are easy to get wrong:

```ts
const addon = defineAddon({
  manifest: {
    /* … */
    resources: ['watch_state'],
    watchState: {
      version: 2,
      viewers: true,
      push: {
        events: ['start', 'pause', 'stop', 'played', 'unplayed'],
        bulk: true,
      },
      pull: { items: true, watched: true, ttlSeconds: 60 },
    },
  },
  watchState: {
    push: async ({ event, viewer, config }) => {
      switch (event.event) {
        case 'stop':
          return saveProgress(
            viewer,
            event.videoId,
            event.positionMs,
            event.played
          );
        case 'played':
          return markWatched(
            viewer,
            'videos' in event ? event.videos : [event]
          );
      }
    },
    pull: async ({ viewer, since }) => ({
      version: await historyVersion(viewer),
      items: await inProgress(viewer),
      watched: () => loadHistory(viewer),
    }),
  },
});
```

- **Typed events**: events arrive parsed and narrowed by `event.event`. Events from senders that left out `scope` get one filled in.
- **Repeats**: a repeated event (same id, configuration and viewer) is answered without calling `push` again. Set `dedupe` to how many ids to remember, or `0` to turn this off.
- **Version gating**: when the reader's `since` matches your `version`, the watched history is left out of the answer and its function is never called. `version` must change whenever the history does.
- **Failed parts**: `watched`, `watchlist` and `ratings` can be values or functions. When a function throws or returns `undefined`, that part is left out and a warning is logged. A reader then keeps what it had, where an empty list would have wiped it.

## Client events

`player` and `library` receive the client's own playback and library changes:

```ts
player: ({ id, action, currentTime, duration }) => scrobble(id, action, currentTime, duration),
library: ({ id, action, videoIds }) => syncLibrary(id, action, videoIds),
```

`currentTime` and `duration` are in milliseconds. `duration` is `undefined` while the player doesn't know it. `library` gets `libraryAdd`, `libraryRemove`, `watched` and `unwatched`. `videoIds` lists the videos marked, or is empty when the whole title was.

## Response checks

Clients drop data they can't read, often without a trace. A stream with a malformed field disappears from the list, and a meta with an invalid poster URL fails to load at all. The SDK checks each answer against what clients accept:

- `validation: 'warn'` (default): logs each distinct problem once and sends the answer anyway.
- `validation: 'strict'`: answers a 500 that names the problem. Use it in development and tests.
- `validation: 'off'`: skips the check.

```
WARN  addon sent a response clients would reject rid=3212314e resource=meta type=movie id=tt1
issues:
  ✖ expected a date-time with its zone, e.g. 2008-01-20T00:00:00Z, or epoch milliseconds
    → at meta.released
```

## Types and schemas

Every protocol type is exported (`Manifest`, `Meta`, `Stream`, `Subtitle`, `WatchStateEvent`, …) with its zod schema (`MetaSchema`, `StreamSchema`, …). Use the schemas to check another addon's output, or in your own tests:

```ts
import { StreamResponseSchema } from '@aiostreams/addon-sdk';

const result = StreamResponseSchema.safeParse(await res.json());
```

## Deploying

`addon.fetch(request)` answers every request, with a 404 for paths that aren't the addon's. `addon.handle(request)` returns `null` for those instead, so the addon can sit among other routes.

**Node**, on Render, Railway, Fly.io, a VPS or Docker:

```ts
import { serve } from '@aiostreams/addon-sdk/node';
await serve(addon); // PORT, or 7000; { port, hostname } to choose
```

Behind a proxy, the forwarded host and scheme are used, so install links carry the address users see. Free plans that put an idle service to sleep, such as Render's free web services, take longer to wake than AIOStreams waits for an addon.

**Docker**, with `npm run build` compiling to `dist/`:

```dockerfile
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 7000
HEALTHCHECK CMD wget -qO /dev/null http://127.0.0.1:${PORT:-7000}/manifest.json || exit 1
CMD ["node", "dist/addon.js"]
```

```yaml
# compose.yaml
services:
  addon:
    build: .
    init: true
    restart: unless-stopped
    ports:
      - 7000:7000
    env_file:
      - path: .env
        required: false
```

```
# .dockerignore
node_modules
dist
.env
.git
```

- `init: true` lets the container stop straight away. Without it, Node runs as the container's first process, ignores the stop signal, and Docker waits 10 seconds before killing it.
- Variables in `.env` reach `defineEnv` through `env_file`. The file itself stays out of the image.
- If AIOStreams runs on the same Docker network, it reaches the addon at `http://addon:7000`. Put that host in place of the one in the link the configure page copies.

**Bun**: `Bun.serve({ port: 7000, fetch: addon.fetch });`

**Deno**: `Deno.serve({ port: 7000 }, addon.fetch);`

**Cloudflare Workers**: export the addon as the module's default.

```ts
export default addon;
```

```toml
# wrangler.toml
name = "my-addon"
main = "src/index.ts"
compatibility_date = "2026-10-01"
```

Set secrets with `wrangler secret put CONFIG_SECRET`, and read them through `defineEnv` with `source: bindings` as above.

### In a framework, or under a path

The addon can sit beside your app's own routes, at the root or under a path such as `/addon`. Install links, the redirect from `/` and `manifestUrl()` keep that path, and requests for your other routes keep their bodies.

Anything that hands you a `Request` calls `addon.handle(request, { basePath })`. It answers `null` for paths that aren't the addon's, and `basePath` is left out at the root:

**Hono**

```ts
app.use(
  '/addon/*',
  async (c, next) =>
    (await addon.handle(c.req.raw, { basePath: '/addon' })) ?? next()
);
```

**Next.js**, as `app/addon/[[...path]]/route.ts`:

```ts
const handler = async (request: Request) =>
  (await addon.handle(request, { basePath: '/addon' })) ??
  new Response('Not found', { status: 404 });

export { handler as GET, handler as HEAD, handler as POST, handler as OPTIONS };
```

**Elysia**

```ts
app.mount(
  '/addon',
  async (request) =>
    (await addon.handle(request, { basePath: '/addon' })) ??
    new Response('Not found', { status: 404 })
);
```

Node frameworks use `toNodeHandler`. Express and Connect report the path they mount it at:

**Express or Connect**

```ts
import { toNodeHandler } from '@aiostreams/addon-sdk/node';
app.use('/addon', toNodeHandler(addon)); // other paths go to next()
```

**Fastify** reads request bodies itself, so the addon's routes get a parser that leaves them alone:

```ts
const handler = toNodeHandler(addon, { basePath: '/addon' });
app.register(
  async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (_request, _payload, done) => done(null));
    for (const url of ['/', '/*']) {
      scope.all(url, (request, reply) => {
        reply.hijack();
        handler(request.raw, reply.raw);
      });
    }
  },
  { prefix: '/addon' }
);
```

**Koa**

```ts
import { finished } from 'node:stream/promises';

const handler = toNodeHandler(addon, { basePath: '/addon' });
app.use(async (ctx, next) => {
  if (ctx.path !== '/addon' && !ctx.path.startsWith('/addon/')) return next();
  ctx.respond = false;
  handler(ctx.req, ctx.res);
  await finished(ctx.res);
});
```

Behind a reverse proxy that serves the addon under a path and strips it, `serve()` and `toNodeHandler` read the path from `X-Forwarded-Prefix`, which Traefik's StripPrefix sends.

## Examples

- [`examples/catalog`](examples/catalog): catalogs, extended metadata, people, similar titles, streams and subtitles, with a generated configure page.
- [`examples/tracker`](examples/tracker): a watch history tracker with `watch_state` push and pull, plus the client's player and library events.
- [`examples/cloudflare-worker`](examples/cloudflare-worker): an encrypted configuration and a custom configure page, on Workers.

## License

MIT
