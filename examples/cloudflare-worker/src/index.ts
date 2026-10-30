import {
  configureLogging,
  defineAddon,
  defineEnv,
} from '@aiostreams/addon-sdk';
import { env as bindings } from 'cloudflare:workers';
import { z } from 'zod';

const env = defineEnv(
  {
    CONFIG_SECRET: z.string().min(32),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  },
  { source: bindings }
);
// Workers Logs keeps each JSON line's fields searchable.
configureLogging({ level: env.LOG_LEVEL, format: 'json' });

const addon = defineAddon({
  manifest: {
    id: 'com.example.worker',
    version: '1.0.0',
    name: 'Example Worker',
    types: ['movie'],
    idPrefixes: ['tt'],
    resources: ['stream'],
    behaviorHints: { configurable: true, configurationRequired: true },
  },
  config: {
    schema: z.object({ token: z.string().min(1) }),
    secret: env.CONFIG_SECRET,
  },
  stream: ({ id, config }) => ({
    streams: [
      {
        name: 'Worker',
        url: `https://cdn.example.com/${id}.mkv?token=${encodeURIComponent(config.token)}`,
      },
    ],
    cacheMaxAge: 600,
  }),
  configure: async ({ request, manifestUrl }) => {
    const token = new URL(request.url).searchParams.get('token');
    if (!token) {
      return '<form><input name="token" placeholder="Token"><button>Get install link</button></form>';
    }
    return `<a href="${await manifestUrl({ token })}">Install</a>`;
  },
});

export default addon;
