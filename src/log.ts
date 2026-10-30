export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

type Write = (fields: Record<string, unknown>, message: string) => void;

/** Fields first, then the message: pino's shape, so a pino logger can be the sink. */
export interface Sink {
  debug: Write;
  info: Write;
  warn: Write;
  error: Write;
}

export interface Logger extends Sink {
  /** A logger that adds these fields to every entry. */
  child(fields: Record<string, unknown>): Logger;
}

export interface LoggingOptions {
  /** `info` by default. */
  level?: LogLevel | 'silent';
  /** JSON lines by default; `pretty` when writing to a terminal. */
  format?: 'json' | 'pretty';
  /** Where entries go instead of the console, e.g. a pino logger. `level` still applies. */
  sink?: Sink;
}

const LEVELS: Record<LogLevel | 'silent', number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

let settings: Required<Pick<LoggingOptions, 'level'>> & LoggingOptions = {
  level: 'info',
};

/** Applies to every logger, including ones made before it is called. */
export function configureLogging(options: LoggingOptions): void {
  settings = { ...settings, ...options };
}

function isTerminal(): boolean {
  const process = (globalThis as { process?: { stdout?: { isTTY?: boolean } } })
    .process;
  return process?.stdout?.isTTY === true;
}

/** Errors become plain objects, so JSON keeps their message, stack and cause. */
function serialise(value: unknown, depth = 0): unknown {
  if (!(value instanceof Error)) return value;
  return {
    type: value.name,
    message: value.message,
    stack: value.stack,
    ...(value.cause !== undefined && depth < 3
      ? { cause: serialise(value.cause, depth + 1) }
      : {}),
  };
}

const COLOURS: Record<LogLevel, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};

function stackOf(error: Error, depth = 0): string {
  const own = error.stack ?? `${error.name}: ${error.message}`;
  return error.cause instanceof Error && depth < 3
    ? `${own}\nCaused by: ${stackOf(error.cause, depth + 1)}`
    : own;
}

function pretty(
  level: LogLevel,
  message: string,
  fields: Record<string, unknown>
): string {
  const time = new Date().toISOString().slice(11, 23);
  const { module, ...rest } = fields;
  const pairs: string[] = [];
  const blocks: string[] = [];
  for (const [key, value] of Object.entries(rest)) {
    if (value === undefined) continue;
    if (value instanceof Error) blocks.push(stackOf(value));
    else if (typeof value === 'string' && value.includes('\n')) {
      blocks.push(`${key}:\n${value.replace(/^/gm, '  ')}`);
    } else if (typeof value === 'string' && !/\s/.test(value))
      pairs.push(`${key}=${value}`);
    else pairs.push(`${key}=${JSON.stringify(value)}`);
  }
  const scope = module ? `\x1b[35m${String(module)}\x1b[0m ` : '';
  const tail = pairs.length ? ` \x1b[2m${pairs.join(' ')}\x1b[0m` : '';
  const line = `\x1b[2m${time}\x1b[0m ${COLOURS[level]}${level.toUpperCase().padEnd(5)}\x1b[0m ${scope}${message}${tail}`;
  return [line, ...blocks].join('\n');
}

function toConsole(
  level: LogLevel,
  fields: Record<string, unknown>,
  message: string
): void {
  const format = settings.format ?? (isTerminal() ? 'pretty' : 'json');
  const line =
    format === 'pretty'
      ? pretty(level, message, fields)
      : JSON.stringify({
          level,
          time: new Date().toISOString(),
          msg: message,
          ...Object.fromEntries(
            Object.entries(fields).map(([key, value]) => [
              key,
              serialise(value),
            ])
          ),
        });
  (level === 'error'
    ? console.error
    : level === 'warn'
      ? console.warn
      : console.log)(line);
}

/** A logger for one part of your addon; every entry is tagged with `module`. */
export function createLogger(
  module: string,
  fields: Record<string, unknown> = {}
): Logger {
  const bound = { module, ...fields };
  const write =
    (level: LogLevel): Write =>
    (extra, message) => {
      if (LEVELS[level] < LEVELS[settings.level]) return;
      const all = { ...bound, ...extra };
      if (settings.sink) settings.sink[level](all, message);
      else toConsole(level, all, message);
    };
  return {
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    child: (more) => createLogger(module, { ...fields, ...more }),
  };
}
