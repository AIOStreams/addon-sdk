import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { Addon } from './addon.js';
import { createLogger } from './log.js';
import { MAX_BODY_BYTES } from './router.js';

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

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Behind a proxy, the forwarded host and scheme make `request.url` the address users see. */
function toRequest(req: IncomingMessage, body: Buffer | undefined): Request {
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
  return new Request(`${protocol}://${host}${req.url ?? '/'}`, {
    method: req.method,
    headers,
    body: body?.length ? new Uint8Array(body) : undefined,
  });
}

async function send(res: ServerResponse, response: Response, head: boolean) {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(head ? undefined : Buffer.from(await response.arrayBuffer()));
}

/** For `node:http`, and as Express or Connect middleware: other paths go to `next`. */
export function toNodeHandler(addon: Pick<Addon<any>, 'handle'>): NodeHandler {
  return (req, res, next) => {
    (async () => {
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const body = hasBody ? await readBody(req) : undefined;
      if (body === null) {
        await send(
          res,
          Response.json({ error: 'Body too large' }, { status: 413 }),
          false
        );
        return;
      }
      const response = await addon.handle(toRequest(req, body));
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
