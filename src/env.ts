import { formatIssues, type StandardSchemaV1 } from './standard-schema.js';

export interface EnvOptions {
  /** Where the variables come from: `process.env` where there is one, or a platform's bindings. */
  source?: object;
  /** Loaded into `process.env` first when it exists; variables already set win. `false` skips it. */
  file?: string | false;
}

export type Env<Shape extends Record<string, StandardSchemaV1>> = {
  readonly [Name in keyof Shape]: StandardSchemaV1.InferOutput<Shape[Name]>;
};

/** Every variable that failed, so they can all be fixed at once. */
export class EnvError extends Error {
  override name = 'EnvError';

  constructor(readonly problems: Record<string, string>) {
    super(
      `Invalid environment:\n${Object.entries(problems)
        .map(([name, problem]) => `  ${name}: ${problem}`)
        .join('\n')}`
    );
  }
}

interface NodeProcess {
  env: Record<string, string | undefined>;
  loadEnvFile?: (path?: string) => void;
}

function loadFile(node: NodeProcess, file: string): void {
  try {
    node.loadEnvFile?.(file);
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error;
  }
}

/**
 * Reads and checks environment variables once, at startup. Values are text:
 * use `z.coerce.number()` or `z.stringbool()` for others. An empty value counts
 * as unset, so a blank line in `.env` falls back to the default.
 */
export function defineEnv<Shape extends Record<string, StandardSchemaV1>>(
  shape: Shape,
  options: EnvOptions = {}
): Env<Shape> {
  const node = (globalThis as { process?: NodeProcess }).process;
  if (!options.source && node && options.file !== false) {
    loadFile(node, options.file ?? '.env');
  }
  const source = (options.source ?? node?.env ?? {}) as Record<string, unknown>;

  const values: Record<string, unknown> = {};
  const problems: Record<string, string> = {};
  for (const [name, schema] of Object.entries(shape)) {
    const raw = source[name];
    const result = schema['~standard'].validate(raw === '' ? undefined : raw);
    if (result instanceof Promise) {
      throw new TypeError(
        `${name}: environment schemas must check synchronously`
      );
    }
    if (result.issues) {
      problems[name] =
        raw === undefined || raw === ''
          ? 'required'
          : formatIssues(result.issues);
    } else {
      values[name] = result.value;
    }
  }
  if (Object.keys(problems).length) throw new EnvError(problems);
  return Object.freeze(values) as Env<Shape>;
}
