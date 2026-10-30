import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { Addon } from './addon.js';
import { createLogger } from './log.js';
import { normaliseBase } from './router.js';

const log = createLogger('server');

export type NodeHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  next?: (error?: unknown) => void
) => void;

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return (Array.isArray(value) ? value[0] : value)?.split(',')[0].trim();
}

/**
 * Read only when the addon reads it, so a request for another route keeps its
 * body. A body parser that ran first leaves the body on `req.body`.
 */
function bodyOf(req: IncomingMessage): BodyInit | undefined {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const parsed = (req as { body?: unknown }).body;
  if (typeof parsed === 'string') return parsed;
  if (parsed instanceof Uint8Array) return new Uint8Array(parsed);
  if (parsed && typeof parsed === 'object') return JSON.stringify(parsed);
  let chunks: AsyncIterator<Buffer> | undefined;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        chunks ??= req[Symbol.asyncIterator]();
        const { done, value } = await chunks.next();
        if (done) controller.close();
        else controller.enqueue(new Uint8Array(value));
      },
    },
    { highWaterMark: 0 }
  );
}

const trimmed = (path: string) => path.split('?')[0].replace(/\/+$/, '');

/** A router that mounts a handler under a path strips it from `url` and keeps the full path in `originalUrl`. */
function locate(req: IncomingMessage, basePath: string | undefined) {
  const prefix = normaliseBase(header(req, 'x-forwarded-prefix'));
  const original =
    (req as { originalUrl?: string }).originalUrl ?? req.url ?? '/';
  const full = trimmed(original);
  const own = trimmed(req.url ?? '/');
  const mount = full.endsWith(own)
    ? full.slice(0, full.length - own.length)
    : '';
  return {
    path: `${prefix}${original}`,
    basePath: `${prefix}${basePath ?? mount}`,
  };
}

/** Behind a proxy, the forwarded host, scheme and prefix make `request.url` the address users see. */
function toRequest(req: IncomingMessage, path: string): Request {
  const encrypted = (req.socket as { encrypted?: boolean }).encrypted;
  const protocol =
    header(req, 'x-forwarded-proto') ?? (encrypted ? 'https' : 'http');
  const host =
    header(req, 'x-forwarded-host') ?? req.headers.host ?? 'localhost';
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value])
      headers.append(name, item);
  }
  return new Request(`${protocol}://${host}${path}`, {
    method: req.method,
    headers,
    body: bodyOf(req),
    duplex: 'half',
  } as RequestInit);
}

async function send(res: ServerResponse, response: Response, head: boolean) {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(head ? undefined : Buffer.from(await response.arrayBuffer()));
}

export interface NodeHandlerOptions {
  /** The path a router serves the addon under, when the router doesn't keep it in `req.originalUrl`. */
  basePath?: string;
}

/** For `node:http`, and as Express or Connect middleware: other paths go to `next`. */
export function toNodeHandler(
  addon: Pick<Addon<any>, 'handle'>,
  options: NodeHandlerOptions = {}
): NodeHandler {
  return (req, res, next) => {
    (async () => {
      const { path, basePath } = locate(req, options.basePath);
      const response = await addon.handle(toRequest(req, path), { basePath });
      if (response) await send(res, response, req.method === 'HEAD');
      else if (next) next();
      else
        await send(
          res,
          Response.json({ error: 'Not found' }, { status: 404 }),
          false
        );
    })().catch((err) => {
      if (next) return next(err);
      log.error({ err, method: req.method }, 'could not answer a request');
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy();
    });
  };
}

export interface ServeOptions {
  /** `PORT` from the environment, else 7000. */
  port?: number;
  hostname?: string;
}

/** Starts an HTTP server for the addon, on every interface by default. */
export function serve(
  addon: Pick<Addon<any>, 'handle'>,
  options: ServeOptions = {}
): Promise<{ server: Server; url: string }> {
  const port = options.port ?? (Number(process.env.PORT) || 7000);
  const server = createServer(toNodeHandler(addon));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, options.hostname, () => {
      const address = server.address();
      const bound =
        typeof address === 'object' && address ? address.port : port;
      const url = `http://localhost:${bound}`;
      log.info({ url }, 'listening');
      resolve({ server, url });
    });
  });
}
