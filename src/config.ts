import { AddonError } from './errors.js';
import { formatIssues, type StandardSchemaV1 } from './standard-schema.js';

/** How the configuration is written into the URL's first path segment. */
export interface ConfigEncoding {
  encode(value: unknown): string | Promise<string>;
  /** `undefined` when the segment cannot be read. */
  decode(segment: string): unknown;
}

export interface ConfigOptions<Config> {
  /** A request without a configuration is given what this makes of `{}`, or refused. */
  schema: StandardSchemaV1<unknown, Config>;
  /** Encrypts the configuration. Changing it invalidates every URL made with the old one. */
  secret?: string;
  /** Your own encoding, e.g. to keep reading an existing addon's URLs. */
  encoding?: ConfigEncoding;
}

export type ConfigDefinition<Config> =
  StandardSchemaV1<unknown, Config> | ConfigOptions<Config>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return undefined;
  try {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Base64url JSON, which survives proxies that rewrite `%2F`; URL-encoded JSON is read too. */
export const jsonEncoding: ConfigEncoding = {
  encode: (value) => toBase64Url(encoder.encode(JSON.stringify(value))),
  decode(segment) {
    let text: string;
    try {
      text = decodeURIComponent(segment);
    } catch {
      return undefined;
    }
    if (text.startsWith('{')) return parseJson(text);
    const bytes = fromBase64Url(segment);
    return bytes ? parseJson(decoder.decode(bytes)) : undefined;
  },
};

const IV_BYTES = 12;

/** AES-GCM over the JSON, with a key derived from `secret`. */
export function sealedEncoding(secret: string): ConfigEncoding {
  if (secret.length < 32) {
    throw new Error('a config secret needs at least 32 characters');
  }
  const key = crypto.subtle
    .digest('SHA-256', encoder.encode(secret))
    .then((digest) =>
      crypto.subtle.importKey('raw', digest, 'AES-GCM', false, [
        'encrypt',
        'decrypt',
      ])
    );
  return {
    async encode(value) {
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const sealed = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv },
          await key,
          encoder.encode(JSON.stringify(value))
        )
      );
      const out = new Uint8Array(IV_BYTES + sealed.length);
      out.set(iv);
      out.set(sealed, IV_BYTES);
      return toBase64Url(out);
    },
    async decode(segment) {
      const bytes = fromBase64Url(segment);
      if (!bytes || bytes.length <= IV_BYTES) return undefined;
      try {
        const plain = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: bytes.subarray(0, IV_BYTES) },
          await key,
          bytes.subarray(IV_BYTES)
        );
        return parseJson(decoder.decode(plain));
      } catch {
        return undefined;
      }
    },
  };
}

export interface ConfigIssue {
  path: string[];
  message: string;
}

export interface ConfigReader<Config> {
  /** Throws an `AddonError` for a configuration that cannot be used. */
  read(segment: string | undefined): Promise<Config>;
  /** The segment's value before it is checked; `undefined` when unreadable. */
  decode(segment: string): Promise<unknown>;
  check(value: unknown): Promise<{ value: Config } | { issues: ConfigIssue[] }>;
  write(config: Config): Promise<string>;
  /** `undefined` when the schema cannot describe itself. */
  jsonSchema(): Record<string, unknown> | undefined;
}

export function configReader<Config>(
  definition: ConfigDefinition<Config>
): ConfigReader<Config> {
  const options: ConfigOptions<Config> =
    '~standard' in definition ? { schema: definition } : definition;
  const encoding =
    options.encoding ??
    (options.secret ? sealedEncoding(options.secret) : jsonEncoding);

  async function validate(value: unknown, missing: boolean) {
    const result = await options.schema['~standard'].validate(value);
    if (!result.issues) return result.value;
    throw new AddonError(
      400,
      missing
        ? 'This addon needs to be configured'
        : `Invalid configuration: ${formatIssues(result.issues)}`
    );
  }

  let jsonSchema: Record<string, unknown> | undefined | null = null;

  return {
    async read(segment) {
      if (segment === undefined) return validate({}, true);
      const value = await encoding.decode(segment);
      if (value === undefined) {
        throw new AddonError(400, 'Unreadable configuration');
      }
      return validate(value, false);
    },
    async decode(segment) {
      return encoding.decode(segment);
    },
    async check(value) {
      const result = await options.schema['~standard'].validate(value);
      if (!result.issues) return { value: result.value };
      return {
        issues: result.issues.map((issue) => ({
          path: (issue.path ?? []).map((segment) =>
            String(typeof segment === 'object' ? segment.key : segment)
          ),
          message: issue.message,
        })),
      };
    },
    async write(config) {
      return encoding.encode(config);
    },
    jsonSchema() {
      if (jsonSchema === null) {
        try {
          jsonSchema = options.schema['~standard'].jsonSchema?.input({
            target: 'draft-2020-12',
          });
        } catch {
          jsonSchema = undefined;
        }
      }
      return jsonSchema;
    },
  };
}
