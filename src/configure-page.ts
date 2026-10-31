import { UI_SCRIPT, UI_STYLE } from './configure-ui.generated.js';
import type { Manifest } from './schemas/manifest.js';

export type JsonSchema = Record<string, unknown>;

export interface Theme {
  /** Any CSS colour; vermilion when absent. */
  accent?: string;
  /** Text on the accent; worked out from a hex `accent` when absent. */
  accentText?: string;
}

interface PageOptions {
  manifest: Manifest;
  schema: JsonSchema;
  values: unknown;
  /** Paths of secret fields that already hold a value. */
  kept: string[][];
  editing: boolean;
  theme?: Theme;
  footer?: string;
}

const embed = (value: unknown) =>
  JSON.stringify(value).replace(/</g, '\\u003c');
const attribute = (text: string) =>
  text.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`);

function textOn(accent: string): string {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(accent)?.[1];
  if (!hex) return '#fff';
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  const [r, g, b] = [0, 2, 4].map(
    (i) => parseInt(full.slice(i, i + 2), 16) / 255
  );
  const linear = (c: number) =>
    c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  const luminance =
    0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  return luminance > 0.36 ? '#0b0c10' : '#fff';
}

/** The page is built from the configuration's JSON Schema; the server checks and encodes what it posts. */
export function configurePage({
  manifest,
  schema,
  values,
  kept,
  editing,
  theme,
  footer,
}: PageOptions): string {
  const accent = theme?.accent ?? '#d9381e';
  const accentText = theme?.accentText ?? textOn(accent);
  const data = {
    manifest: {
      name: manifest.name,
      description: manifest.description,
      logo: manifest.logo,
      background: manifest.background,
      version: manifest.version,
      types: manifest.types,
      resources: manifest.resources.map((r) =>
        typeof r === 'string' ? r : r.name
      ),
    },
    schema,
    values,
    kept,
    editing,
    footer,
  };
  const icon = /^https?:/.test(manifest.logo ?? '')
    ? `<link rel="icon" href="${attribute(manifest.logo!)}">`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${attribute(`Configure ${manifest.name}`)}</title>
${icon}
<style>:root{--accent:${attribute(accent)};--on-accent:${attribute(accentText)}}${UI_STYLE}</style>
</head>
<body>
<div id="app"></div>
<script type="application/json" id="data">${embed(data)}</script>
<script>${UI_SCRIPT}</script>
</body>
</html>`;
}

/** The page marks each list entry with where it started, so a moved entry keeps its own secrets. */
const ORIGIN = '$origin';

type Values = Record<string, unknown>;
const isRecord = (value: unknown): value is Values =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** An object's fields, or those of the variant whose constants the value carries. */
function propertiesOf(
  schema: JsonSchema,
  value: unknown
): Record<string, JsonSchema> | undefined {
  if (schema.properties) return schema.properties as Record<string, JsonSchema>;
  const options = (schema.oneOf ?? schema.anyOf) as JsonSchema[] | undefined;
  if (!options || !isRecord(value)) return undefined;
  const variant = options.find(
    (option) =>
      option.properties &&
      Object.entries(option.properties as Record<string, JsonSchema>).every(
        ([key, child]) =>
          child.const === undefined || value[key] === child.const
      )
  );
  return variant?.properties as Record<string, JsonSchema> | undefined;
}

/** Values to show in the form: secret fields are left out and listed as kept instead. */
export function withoutSecrets(
  schema: JsonSchema,
  value: unknown,
  path: string[] = []
): { values: unknown; kept: string[][] } {
  if (Array.isArray(value)) {
    const items = (schema.items ?? {}) as JsonSchema;
    const kept: string[][] = [];
    const values = value.map((item, index) => {
      const nested = withoutSecrets(items, item, [...path, String(index)]);
      kept.push(...nested.kept);
      return nested.values;
    });
    return { values, kept };
  }
  const properties = propertiesOf(schema, value);
  if (!properties || !isRecord(value)) return { values: value, kept: [] };
  const values: Values = {};
  const kept: string[][] = [];
  for (const [key, child] of Object.entries(value)) {
    const childSchema = properties[key] ?? {};
    if (childSchema.writeOnly === true) {
      if (child !== undefined && child !== '') kept.push([...path, key]);
      continue;
    }
    const nested = withoutSecrets(childSchema, child, [...path, key]);
    values[key] = nested.values;
    kept.push(...nested.kept);
  }
  return { values, kept };
}

/**
 * Secret fields left blank keep their current value: in a list, the value of the
 * entry they started as, and only while it is still the same variant.
 */
export function keepSecrets(
  schema: JsonSchema,
  submitted: unknown,
  current: unknown
): unknown {
  if (Array.isArray(submitted)) {
    const items = (schema.items ?? {}) as JsonSchema;
    return submitted.map((item) => {
      if (!isRecord(item)) return item;
      const { [ORIGIN]: origin, ...rest } = item;
      const previous =
        typeof origin === 'number' && Array.isArray(current)
          ? current[origin]
          : undefined;
      return keepSecrets(items, rest, previous);
    });
  }
  const properties = propertiesOf(schema, submitted);
  if (!properties || !isRecord(submitted)) return submitted;
  const sameShape = propertiesOf(schema, current) === properties;
  const out: Values = { ...submitted };
  for (const [key, childSchema] of Object.entries(properties)) {
    const previous = sameShape && isRecord(current) ? current[key] : undefined;
    if (childSchema.writeOnly === true) {
      if (out[key] === undefined && previous !== undefined) out[key] = previous;
    } else if (out[key] !== undefined) {
      out[key] = keepSecrets(childSchema, out[key], previous);
    }
  }
  return out;
}
