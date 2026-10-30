import {
  configureLogging,
  type Addon,
  type LogLevel,
  type Manifest,
} from '../src/index.js';

// Quiet unless a test collects the entries.
configureLogging({ level: 'silent' });

export interface Entry {
  level: LogLevel;
  fields: Record<string, unknown>;
  message: string;
}

/** Collects every entry from here on. Tests in a file run one at a time. */
export function collectLogs(): Entry[] {
  const entries: Entry[] = [];
  const at =
    (level: LogLevel) => (fields: Record<string, unknown>, message: string) =>
      entries.push({ level, fields, message });
  configureLogging({
    level: 'debug',
    sink: {
      debug: at('debug'),
      info: at('info'),
      warn: at('warn'),
      error: at('error'),
    },
  });
  return entries;
}

export const BASE = 'http://addon.test';

export function call(
  addon: Pick<Addon<any>, 'fetch'>,
  path: string,
  init?: RequestInit
): Promise<Response> {
  return addon.fetch(new Request(`${BASE}${path}`, init));
}

export function manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    id: 'test.addon',
    version: '1.0.0',
    name: 'Test',
    types: ['movie', 'series'],
    resources: ['stream'],
    ...overrides,
  };
}
