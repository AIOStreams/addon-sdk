import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { render, type ComponentChildren } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { parseBlocks, parseInline, plain, type Inline } from './markdown';

type Schema = Record<string, any>;
type Values = Record<string, unknown>;

interface PageData {
  manifest: {
    name: string;
    description?: string;
    logo?: string;
    background?: string;
    version?: string;
    types: string[];
    resources: string[];
  };
  schema: Schema;
  values: Values | undefined;
  kept: string[][];
  editing: boolean;
}

const data: PageData = JSON.parse(
  document.getElementById('data')!.textContent!
);
const root = data.schema;
const kept = new Set(data.kept.map((path) => path.join('.')));
/** Where a list entry started; the server uses it to give a moved entry back its own secrets. */
const ORIGIN = '$origin';

const RESOURCES: Record<string, string> = {
  stream: 'Streams',
  catalog: 'Catalogs',
  meta: 'Details',
  subtitles: 'Subtitles',
  addon_catalog: 'Addon lists',
  watch_state: 'Watch history',
  player: 'Playback sync',
  library: 'Library sync',
};
/** What a client other than AIOStreams can use. */
const STREMIO_RESOURCES = new Set([
  'stream',
  'catalog',
  'meta',
  'subtitles',
  'addon_catalog',
  'player',
  'library',
]);
const TYPES: Record<string, string> = {
  movie: 'Movies',
  series: 'Series',
  anime: 'Anime',
  tv: 'Live TV',
  channel: 'Channels',
  person: 'People',
};

const humanise = (key: string) =>
  key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());

const singular = (title: string) =>
  title.replace(/(ies|s)$/i, (end) => (end.toLowerCase() === 'ies' ? 'y' : ''));

function resolve(schema: Schema | undefined): Schema {
  if (!schema) return {};
  if (schema.$ref) {
    const name = String(schema.$ref).split('/').pop()!;
    return resolve((root.$defs ?? root.definitions ?? {})[name]);
  }
  const options = schema.anyOf ?? schema.oneOf;
  if (options) {
    const real = options.filter((option: Schema) => option.type !== 'null');
    if (real.length === 1) {
      const { anyOf, oneOf, ...rest } = schema;
      return { ...rest, ...resolve(real[0]) };
    }
  }
  return schema;
}

const isGroup = (schema: Schema) =>
  schema.type === 'object' && !!schema.properties;

interface Variants {
  key: string;
  options: Schema[];
}

/** Objects told apart by a field that is a constant in each, as a discriminated union describes them. */
function variantsOf(schema: Schema): Variants | null {
  const options = (schema.oneOf ?? schema.anyOf)
    ?.map(resolve)
    .filter((option: Schema) => option.type !== 'null');
  if (!options || options.length < 2 || !options.every(isGroup)) return null;
  const key = Object.keys(options[0].properties).find((name) =>
    options.every(
      (option: Schema) => option.properties[name]?.const !== undefined
    )
  );
  return key ? { key, options } : null;
}

const variantOf = (variants: Variants, value: unknown) =>
  variants.options.find(
    (option) =>
      option.properties[variants.key].const ===
      (value as Values | undefined)?.[variants.key]
  ) ?? variants.options[0];

const variantLabel = (variants: Variants, option: Schema) => {
  const discriminator = option.properties[variants.key];
  return discriminator.title ?? option.title ?? String(discriminator.const);
};

const isEntry = (schema: Schema) => isGroup(schema) || !!variantsOf(schema);

function initial(schema: Schema, value: unknown): unknown {
  const resolved = resolve(schema);
  const current = value ?? resolved.default;
  const variants = variantsOf(resolved);
  if (variants) {
    const option = variantOf(variants, current);
    return {
      ...(initial(option, current) as Values),
      [variants.key]: option.properties[variants.key].const,
    };
  }
  if (
    resolved.type === 'array' &&
    Array.isArray(current) &&
    isEntry(resolve(resolved.items))
  ) {
    return current.map((item, index) => ({
      ...(initial(resolved.items, item) as Values),
      [ORIGIN]: index,
    }));
  }
  if (!isGroup(resolved)) return current;
  const out: Values = {};
  for (const [key, child] of Object.entries<Schema>(resolved.properties)) {
    out[key] = initial(child, (current as Values | undefined)?.[key]);
  }
  return out;
}

/** Empty answers are left out, so the schema's defaults and optional fields apply. */
function prune(value: unknown): unknown {
  if (value === '' || value === undefined) return undefined;
  if (Array.isArray(value))
    return value.map(prune).filter((item) => item !== undefined);
  if (value === null || typeof value !== 'object') return value;
  const out: Values = {};
  for (const [key, child] of Object.entries(value)) {
    const pruned = prune(child);
    if (pruned !== undefined) out[key] = pruned;
  }
  return Object.keys(out).length ? out : undefined;
}

function getIn(target: unknown, path: string[]): unknown {
  return path.reduce<unknown>((at, key) => (at as any)?.[key], target);
}

function setIn(target: unknown, path: string[], value: unknown): any {
  if (!path.length) return value;
  const [head, ...rest] = path;
  if (Array.isArray(target)) {
    const copy = [...target];
    copy[Number(head)] = setIn(copy[Number(head)], rest, value);
    return copy;
  }
  const object = (target ?? {}) as Values;
  return { ...object, [head]: setIn(object[head], rest, value) };
}

/** A new value, or a function of the latest one, so an edit not yet rendered is never overwritten. */
type Change = unknown | ((current: any) => unknown);
type OnChange = (path: string[], value: Change) => void;

type IconName =
  | 'check'
  | 'copy'
  | 'eye'
  | 'eye-off'
  | 'x'
  | 'alert'
  | 'grip'
  | 'up'
  | 'down'
  | 'plus';

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, string> = {
    check: 'M5 12.5l4.5 4.5L19 7.5',
    copy: 'M9 9h10v10H9zM5 15V5h10',
    eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zm10 3a3 3 0 100-6 3 3 0 000 6z',
    'eye-off':
      'M3 3l18 18M10.6 5.1A10.4 10.4 0 0112 5c6.5 0 10 7 10 7a17.6 17.6 0 01-3.2 4.2M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7c1.8 0 3.4-.5 4.8-1.3M9.9 9.9a3 3 0 004.2 4.2',
    x: 'M6 6l12 12M18 6L6 18',
    alert: 'M12 8v5m0 3.5v.5M12 3l10 18H2z',
    grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
    up: 'M6 15l6-6 6 6',
    down: 'M6 9l6 6 6-6',
    plus: 'M12 5v14M5 12h14',
  };
  return (
    <svg class={`icon icon-${name}`} viewBox="0 0 24 24" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}

function Inlines({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((node, i) => {
        if (typeof node === 'string') return node;
        switch (node.type) {
          case 'br':
            return <br key={i} />;
          case 'code':
            return <code key={i}>{node.text}</code>;
          case 'image':
            return (
              <img key={i} class="md-image" src={node.src} alt={node.alt} />
            );
          case 'link':
            return (
              <a
                key={i}
                href={node.href}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Inlines nodes={node.children} />
              </a>
            );
          default: {
            const Tag = node.type;
            return (
              <Tag key={i}>
                <Inlines nodes={node.children} />
              </Tag>
            );
          }
        }
      })}
    </>
  );
}

const Rich = ({ text }: { text: string }) => (
  <Inlines nodes={parseInline(text)} />
);

function Markdown({
  text,
  class: className,
  id,
}: {
  text: string;
  class?: string;
  id?: string;
}) {
  const headings = ['h4', 'h5', 'h6'] as const;
  return (
    <div class={className ? `md ${className}` : 'md'} id={id}>
      {parseBlocks(text).map((block, i) => {
        if (block.type === 'paragraph')
          return (
            <p key={i}>
              <Inlines nodes={block.children} />
            </p>
          );
        if (block.type === 'heading') {
          const Heading = headings[block.level - 1];
          return (
            <Heading key={i}>
              <Inlines nodes={block.children} />
            </Heading>
          );
        }
        const items = block.items.map((item, j) => (
          <li key={j}>
            <Inlines nodes={item} />
          </li>
        ));
        return block.ordered ? (
          <ol key={i} start={block.start === 1 ? undefined : block.start}>
            {items}
          </ol>
        ) : (
          <ul key={i}>{items}</ul>
        );
      })}
    </div>
  );
}

interface FieldProps {
  name: string;
  schema: Schema;
  path: string[];
  /** Where a saved secret for this field is listed; `null` for an entry that has none. */
  saved?: string[] | null;
  value: unknown;
  required: boolean;
  errors: Record<string, string>;
  onChange: OnChange;
}

const savedPath = (props: FieldProps) =>
  props.saved === null ? null : (props.saved ?? props.path);
const childSaved = (props: FieldProps, ...keys: string[]) => {
  const base = savedPath(props);
  return base === null ? null : [...base, ...keys];
};

function Label({
  id,
  schema,
  name,
  required,
  extra,
}: {
  id: string;
  schema: Schema;
  name: string;
  required: boolean;
  extra?: ComponentChildren;
}) {
  const optional =
    !required && schema.default === undefined && schema.type !== 'boolean';
  return (
    <div class="field-head">
      <label class="field-label" id={`${id}-label`} for={id}>
        <span>
          <Rich text={schema.title ?? humanise(name)} />
        </span>
        {optional && <span class="pill">Optional</span>}
        {extra}
      </label>
      {schema.description && (
        <Markdown
          class="field-hint"
          id={`${id}-hint`}
          text={schema.description}
        />
      )}
    </div>
  );
}

function Problem({ id, message }: { id: string; message?: string }) {
  return message ? (
    <p class="field-error" id={`${id}-error`} role="alert">
      <Icon name="alert" />
      {message}
    </p>
  ) : null;
}

function Choice({
  id,
  options,
  label,
  value,
  onChange,
  described,
}: {
  id: string;
  options: unknown[];
  label: (o: unknown) => string;
  value: unknown;
  onChange: (v: unknown) => void;
  described?: string;
}) {
  const short =
    options.length <= 4 &&
    options.every((option) => label(option).length <= 14);
  return short ? (
    <div
      class="segmented"
      role="radiogroup"
      aria-labelledby={`${id}-label`}
      aria-describedby={described}
    >
      {options.map((option) => (
        <button
          type="button"
          key={String(option)}
          role="radio"
          aria-checked={value === option}
          class={value === option ? 'on' : ''}
          onClick={() => onChange(option)}
        >
          {label(option)}
        </button>
      ))}
    </div>
  ) : (
    <div class="select">
      <select
        id={id}
        aria-describedby={described}
        value={value === undefined ? '' : JSON.stringify(value)}
        onChange={(e) => {
          const raw = (e.target as HTMLSelectElement).value;
          onChange(raw === '' ? undefined : JSON.parse(raw));
        }}
      >
        {value === undefined && <option value="">Choose…</option>}
        {options.map((option) => (
          <option key={String(option)} value={JSON.stringify(option)}>
            {label(option)}
          </option>
        ))}
      </select>
    </div>
  );
}

function Fields({ schema, props }: { schema: Schema; props: FieldProps }) {
  const { path, value, errors, onChange } = props;
  return (
    <div class="fields">
      {Object.entries<Schema>(schema.properties).map(([child, childSchema]) => (
        <Field
          key={child}
          name={child}
          schema={childSchema}
          path={[...path, child]}
          saved={childSaved(props, child)}
          value={(value as Values | undefined)?.[child]}
          required={(schema.required ?? []).includes(child)}
          errors={errors}
          onChange={onChange}
        />
      ))}
    </div>
  );
}

/** The fields of the chosen variant, under a picker for which one. */
function VariantFields({
  variants,
  props,
}: {
  variants: Variants;
  props: FieldProps;
}) {
  const { path, value, errors, onChange } = props;
  const option = variantOf(variants, value);
  const id = `f-${[...path, variants.key].join('-')}`;
  const { [variants.key]: _, ...rest } = option.properties;
  const pickerSchema = option.properties[variants.key];
  return (
    <div class="fields">
      <div class="field">
        <Label
          id={id}
          schema={{
            ...pickerSchema,
            title:
              pickerSchema.title === variantLabel(variants, option)
                ? undefined
                : pickerSchema.title,
          }}
          name={variants.key}
          required
        />
        <Choice
          id={id}
          options={variants.options.map(
            (o) => o.properties[variants.key].const
          )}
          label={(constant) =>
            plain(
              variantLabel(
                variants,
                variants.options.find(
                  (o) => o.properties[variants.key].const === constant
                )!
              )
            )
          }
          value={option.properties[variants.key].const}
          onChange={(constant) => {
            const next = variants.options.find(
              (o) => o.properties[variants.key].const === constant
            )!;
            onChange(path, (row: Values | undefined) => ({
              ...(initial(next, { [variants.key]: constant }) as Values),
              ...(row?.[ORIGIN] === undefined ? {} : { [ORIGIN]: row[ORIGIN] }),
            }));
          }}
        />
        <Problem id={id} message={errors[[...path, variants.key].join('.')]} />
      </div>
      {Object.keys(rest).length > 0 && (
        <Fields schema={{ ...option, properties: rest }} props={props} />
      )}
    </div>
  );
}

function useListKeys(length: number) {
  const next = useRef(0);
  const make = () => `k${next.current++}`;
  const [keys, setKeys] = useState(() => Array.from({ length }, make));
  if (keys.length !== length) {
    const fixed = Array.from({ length }, (_, i) => keys[i] ?? make());
    setKeys(fixed);
    return { keys: fixed, setKeys, make };
  }
  return { keys, setKeys, make };
}

function SortableRow({
  id,
  children,
}: {
  id: string;
  children: (
    handle: Record<string, unknown>,
    dragging: boolean
  ) => ComponentChildren;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
  return (
    <li
      ref={setNodeRef}
      class={isDragging ? 'row dragging' : 'row'}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      {children(
        { ref: setActivatorNodeRef, ...attributes, ...listeners },
        isDragging
      )}
    </li>
  );
}

/** A list whose entries can be dragged, or moved with the arrows or the keyboard. */
function SortableList({
  path,
  title,
  items,
  onChange,
  blank,
  renderItem,
}: {
  path: string[];
  title: string;
  items: unknown[];
  onChange: OnChange;
  blank: () => unknown;
  renderItem: (item: unknown, index: number) => ComponentChildren;
}) {
  const { keys, setKeys, make } = useListKeys(items.length);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const move = (from: number, to: number) => {
    if (to < 0 || to >= items.length || from === to) return;
    setKeys((current) => arrayMove(current, from, to));
    onChange(path, (list: unknown[] = []) => arrayMove(list, from, to));
  };
  const remove = (index: number) => {
    setKeys((current) => current.filter((_, i) => i !== index));
    onChange(path, (list: unknown[] = []) =>
      list.filter((_, i) => i !== index)
    );
  };
  const add = () => {
    setKeys((current) => [...current, make()]);
    onChange(path, (list: unknown[] = []) => [...list, blank()]);
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>(
          `#f-${[...path, items.length].join('-')}, [id^="f-${[...path, items.length].join('-')}-"]`
        )
        ?.focus()
    );
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (over && active.id !== over.id)
      move(keys.indexOf(String(active.id)), keys.indexOf(String(over.id)));
  };
  const name = singular(plain(title)).toLowerCase();
  return (
    <div class="list">
      {items.length > 0 && (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={onDragEnd}
        >
          <SortableContext items={keys} strategy={verticalListSortingStrategy}>
            <ol class="rows">
              {items.map((item, index) => (
                <SortableRow key={keys[index]} id={keys[index]}>
                  {(handle) => (
                    <>
                      <button
                        type="button"
                        class="grip"
                        aria-label={`Drag to move ${name} ${index + 1}`}
                        {...handle}
                      >
                        <Icon name="grip" />
                      </button>
                      <div class="row-body">{renderItem(item, index)}</div>
                      <div class="row-tools">
                        <button
                          type="button"
                          class="tool"
                          aria-label="Move up"
                          disabled={index === 0}
                          onClick={() => move(index, index - 1)}
                        >
                          <Icon name="up" />
                        </button>
                        <button
                          type="button"
                          class="tool"
                          aria-label="Move down"
                          disabled={index === items.length - 1}
                          onClick={() => move(index, index + 1)}
                        >
                          <Icon name="down" />
                        </button>
                        <button
                          type="button"
                          class="tool remove"
                          aria-label={`Remove ${name} ${index + 1}`}
                          onClick={() => remove(index)}
                        >
                          <Icon name="x" />
                        </button>
                      </div>
                    </>
                  )}
                </SortableRow>
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      )}
      <button type="button" class="add" onClick={add}>
        <Icon name="plus" />
        Add {name}
      </button>
    </div>
  );
}

function Field(props: FieldProps) {
  const { name, path, value, required, errors, onChange } = props;
  const schema = resolve(props.schema);
  const id = `f-${path.join('-')}`;
  const key = path.join('.');
  const error = errors[key];
  const set = (next: unknown) => onChange(path, next);
  const described =
    [schema.description && `${id}-hint`, error && `${id}-error`]
      .filter(Boolean)
      .join(' ') || undefined;
  const title = schema.title ?? humanise(name);
  const variants = variantsOf(schema);

  if (isGroup(schema) || variants) {
    return (
      <section class="group" aria-labelledby={`${id}-label`}>
        <h3 class="group-title" id={`${id}-label`}>
          <Rich text={title} />
        </h3>
        {schema.description && (
          <Markdown class="field-hint" text={schema.description} />
        )}
        {variants ? (
          <VariantFields variants={variants} props={props} />
        ) : (
          <Fields schema={schema} props={props} />
        )}
        <Problem id={id} message={error} />
      </section>
    );
  }

  if (schema.type === 'boolean') {
    const on = value === true;
    return (
      <div class={`field switch-row${error ? ' invalid' : ''}`}>
        <Label id={id} schema={schema} name={name} required={required} />
        <button
          type="button"
          id={id}
          class="switch"
          role="switch"
          aria-checked={on}
          aria-describedby={described}
          onClick={() => set(!on)}
        >
          <span class="knob" />
        </button>
        <Problem id={id} message={error} />
      </div>
    );
  }

  const items = schema.type === 'array' ? resolve(schema.items) : undefined;
  let control: ComponentChildren;

  if (items?.enum) {
    const chosen = new Set(Array.isArray(value) ? value : []);
    control = (
      <div
        class="chips"
        role="group"
        aria-labelledby={`${id}-label`}
        aria-describedby={described}
      >
        {items.enum.map((option: unknown) => {
          const on = chosen.has(option);
          return (
            <button
              type="button"
              key={String(option)}
              class={`chip${on ? ' on' : ''}`}
              aria-pressed={on}
              onClick={() =>
                set(
                  items.enum.filter((o: unknown) =>
                    o === option ? !on : chosen.has(o)
                  )
                )
              }
            >
              {String(option)}
            </button>
          );
        })}
      </div>
    );
  } else if (items && isEntry(items)) {
    const entryVariants = variantsOf(items);
    const list = Array.isArray(value) ? (value as Values[]) : [];
    control = (
      <SortableList
        path={path}
        title={items.title ?? title}
        items={list}
        onChange={onChange}
        blank={() => initial(schema.items, undefined)}
        renderItem={(item, index) => {
          const origin = (item as Values)[ORIGIN];
          const rowProps: FieldProps = {
            ...props,
            path: [...path, String(index)],
            saved:
              typeof origin === 'number' && savedPath(props)
                ? [...savedPath(props)!, String(origin)]
                : null,
            value: item,
          };
          return entryVariants ? (
            <VariantFields variants={entryVariants} props={rowProps} />
          ) : (
            <Fields schema={items} props={rowProps} />
          );
        }}
      />
    );
  } else if (items) {
    const numeric = items.type === 'number' || items.type === 'integer';
    const list = Array.isArray(value) ? value : [];
    control = (
      <SortableList
        path={path}
        title={items.title ?? title}
        items={list}
        onChange={onChange}
        blank={() => ''}
        renderItem={(item, index) => {
          const itemId = `${id}-${index}`;
          const itemError = errors[[...path, index].join('.')];
          return (
            <div class={itemError ? 'invalid' : undefined}>
              <input
                id={itemId}
                class="input"
                type={
                  numeric ? 'number' : items.format === 'uri' ? 'url' : 'text'
                }
                value={item === undefined ? '' : String(item)}
                spellcheck={false}
                placeholder={items.format === 'uri' ? 'https://' : undefined}
                aria-label={`${singular(plain(title))} ${index + 1}`}
                onInput={(e) => {
                  const raw = (e.target as HTMLInputElement).value;
                  onChange(
                    [...path, String(index)],
                    numeric && raw !== '' ? Number(raw) : raw
                  );
                }}
              />
              <Problem id={itemId} message={itemError} />
            </div>
          );
        }}
      />
    );
  } else if (schema.enum) {
    control = (
      <Choice
        id={id}
        options={schema.enum}
        label={String}
        value={value}
        onChange={set}
        described={described}
      />
    );
  } else if (schema.type === 'number' || schema.type === 'integer') {
    control = (
      <NumberInput
        id={id}
        schema={schema}
        value={value as number | undefined}
        onChange={set}
        described={described}
      />
    );
  } else if (schema.type === 'string') {
    const saved = savedPath(props);
    control = (
      <TextInput
        id={id}
        schema={schema}
        value={(value as string | undefined) ?? ''}
        onChange={set}
        described={described}
        saved={!!saved && kept.has(saved.join('.'))}
      />
    );
  } else {
    control = (
      <textarea
        id={id}
        class="input mono"
        rows={4}
        aria-describedby={described}
        value={value === undefined ? '' : JSON.stringify(value, null, 2)}
        onInput={(e) => {
          const raw = (e.target as HTMLTextAreaElement).value;
          try {
            set(raw.trim() ? JSON.parse(raw) : undefined);
          } catch {
            set(raw);
          }
        }}
      />
    );
  }

  const saved = savedPath(props);
  return (
    <div class={`field${error ? ' invalid' : ''}`}>
      <Label
        id={id}
        schema={schema}
        name={name}
        required={required}
        extra={
          !!saved &&
          kept.has(saved.join('.')) && <span class="pill saved">Saved</span>
        }
      />
      {control}
      <Problem id={id} message={error} />
    </div>
  );
}

function TextInput({
  id,
  schema,
  value,
  onChange,
  described,
  saved,
}: {
  id: string;
  schema: Schema;
  value: string;
  onChange: (v: unknown) => void;
  described?: string;
  saved: boolean;
}) {
  const secret = schema.writeOnly === true;
  const [shown, setShown] = useState(false);
  const type =
    secret && !shown
      ? 'password'
      : schema.format === 'uri'
        ? 'url'
        : schema.format === 'email'
          ? 'email'
          : 'text';
  return (
    <div class="input-wrap">
      <input
        id={id}
        class="input"
        type={type}
        value={value}
        maxLength={schema.maxLength}
        autoComplete={secret ? 'off' : undefined}
        spellcheck={false}
        placeholder={
          saved
            ? 'Leave blank to keep the saved value'
            : schema.format === 'uri'
              ? 'https://'
              : undefined
        }
        aria-describedby={described}
        onInput={(e) => onChange((e.target as HTMLInputElement).value)}
      />
      {secret && (
        <button
          type="button"
          class="ghost-icon"
          aria-label={shown ? 'Hide' : 'Show'}
          onClick={() => setShown(!shown)}
        >
          <Icon name={shown ? 'eye-off' : 'eye'} />
        </button>
      )}
    </div>
  );
}

function NumberInput({
  id,
  schema,
  value,
  onChange,
  described,
}: {
  id: string;
  schema: Schema;
  value: number | undefined;
  onChange: (v: unknown) => void;
  described?: string;
}) {
  const { minimum: min, maximum: max } = schema;
  const step = schema.type === 'integer' ? 1 : 'any';
  const read = (raw: string) => onChange(raw === '' ? undefined : Number(raw));
  if (min !== undefined && max !== undefined && max - min <= 1000) {
    const shown = value ?? min;
    return (
      <div class="slider">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={shown}
          aria-labelledby={`${id}-label`}
          aria-describedby={described}
          style={{ '--fill': `${((shown - min) / (max - min || 1)) * 100}%` }}
          onInput={(e) => read((e.target as HTMLInputElement).value)}
        />
        <input
          id={id}
          class="input number"
          type="number"
          min={min}
          max={max}
          step={step}
          value={value ?? ''}
          onInput={(e) => read((e.target as HTMLInputElement).value)}
        />
      </div>
    );
  }
  return (
    <input
      id={id}
      class="input"
      type="number"
      min={min}
      max={max}
      step={step}
      value={value ?? ''}
      aria-describedby={described}
      onInput={(e) => read((e.target as HTMLInputElement).value)}
    />
  );
}

function Mark() {
  const { name, logo } = data.manifest;
  const [failed, setFailed] = useState(!/^https?:/.test(logo ?? ''));
  return failed ? (
    <div class="mark monogram" aria-hidden="true">
      {name.trim().charAt(0).toUpperCase()}
    </div>
  ) : (
    <img class="mark" src={logo} alt="" onError={() => setFailed(true)} />
  );
}

/** The nearest field on the page that holds a reported path. */
function placeIssue(path: string[]): { key: string; where: string } | null {
  for (let depth = path.length; depth > 0; depth--) {
    const at = path.slice(0, depth);
    if (
      document.getElementById(`f-${at.join('-')}`) ||
      document.getElementById(`f-${at.join('-')}-label`)
    ) {
      const rest = path.slice(depth);
      const where =
        rest.length === 1 && /^\d+$/.test(rest[0])
          ? `Item ${Number(rest[0]) + 1}: `
          : rest.length
            ? `${rest.join('.')}: `
            : '';
      return { key: at.join('.'), where };
    }
  }
  return null;
}

function App() {
  const [values, setValues] = useState(
    () => initial(root, data.values) as Values
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState<'copy' | 'stremio' | null>(null);
  const [link, setLink] = useState('');
  const [copied, setCopied] = useState(false);
  const { manifest } = data;

  const change: OnChange = (path, value) => {
    setValues((current) =>
      setIn(
        current,
        path,
        typeof value === 'function' ? value(getIn(current, path)) : value
      )
    );
    setLink('');
    const key = path.join('.');
    setErrors((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(
          ([k]) => k !== key && !k.startsWith(`${key}.`)
        )
      );
      return Object.keys(next).length === Object.keys(current).length
        ? current
        : next;
    });
  };

  async function create(): Promise<string | undefined> {
    setProblem('');
    const response = await fetch(location.pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: prune(values) ?? {} }),
    }).catch(() => undefined);
    const body = await response?.json().catch(() => ({}));
    if (!response) {
      setProblem(
        'Could not reach the addon. Check your connection and try again.'
      );
      return;
    }
    if (!response.ok) {
      const found: Record<string, string> = {};
      const general: string[] = [];
      for (const issue of body.issues ?? []) {
        const place = placeIssue(issue.path);
        if (place)
          found[place.key] = [found[place.key], place.where + issue.message]
            .filter(Boolean)
            .join('. ');
        else general.push(issue.message);
      }
      setErrors(found);
      setProblem(
        general.join('. ') ||
          (Object.keys(found).length
            ? 'A few fields need another look.'
            : (body.error ?? 'Something went wrong.'))
      );
      requestAnimationFrame(() =>
        document
          .querySelector<HTMLElement>(
            '.invalid input, .invalid button, .invalid select'
          )
          ?.focus()
      );
      return;
    }
    setErrors({});
    setLink(body.manifestUrl);
    return body.manifestUrl;
  }

  async function run(action: 'copy' | 'stremio') {
    setBusy(action);
    try {
      const url = link || (await create());
      if (!url) return;
      if (action === 'stremio') {
        location.href = url.replace(/^https?:/, 'stremio:');
      } else {
        await navigator.clipboard.writeText(url).catch(() => undefined);
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      }
    } finally {
      setBusy(null);
    }
  }

  const fields = Object.entries<Schema>(resolve(root).properties ?? {});
  const capabilities = manifest.resources
    .map((r) => RESOURCES[r])
    .filter(Boolean);
  const kinds = manifest.types.map((t) => TYPES[t] ?? humanise(t));
  const forStremio = manifest.resources.some((r) => STREMIO_RESOURCES.has(r));
  const art = /^https?:/.test(manifest.background ?? '')
    ? manifest.background
    : undefined;

  return (
    <div class="page">
      <header class={art ? 'hero has-art' : 'hero'}>
        {art && (
          <div
            class="art"
            style={{ backgroundImage: `url("${encodeURI(art)}")` }}
          />
        )}
        <div class="hero-inner">
          <Mark />
          <div class="title">
            <h1>{manifest.name}</h1>
            <dl class="facts">
              {manifest.version && (
                <div>
                  <dt>Version</dt>
                  <dd>{manifest.version}</dd>
                </div>
              )}
              {capabilities.length > 0 && (
                <div>
                  <dt>Adds</dt>
                  <dd>{capabilities.join(', ')}</dd>
                </div>
              )}
              {kinds.length > 0 && (
                <div>
                  <dt>For</dt>
                  <dd>{kinds.join(', ')}</dd>
                </div>
              )}
            </dl>
            {manifest.description && (
              <Markdown class="about" text={manifest.description} />
            )}
          </div>
        </div>
      </header>

      <main class="panel">
        {data.editing && (
          <p class="notice">
            You're changing an installed setup. Replace the addon's link in
            AIOStreams with the new one.
          </p>
        )}
        <form
          id="settings"
          novalidate
          onSubmit={(e) => {
            e.preventDefault();
            void run('copy');
          }}
        >
          <div class="fields">
            {fields.length === 0 && (
              <p class="field-hint">
                Nothing to set up. Copy the link as it is.
              </p>
            )}
            {fields.map(([name, schema]) => (
              <Field
                key={name}
                name={name}
                schema={schema}
                path={[name]}
                value={values[name]}
                required={(resolve(root).required ?? []).includes(name)}
                errors={errors}
                onChange={change}
              />
            ))}
          </div>
        </form>
        <div class="actions">
          {problem && (
            <p class="form-error" role="alert">
              <Icon name="alert" />
              {problem}
            </p>
          )}
          {link && (
            <p class="link" title={link}>
              {link}
            </p>
          )}
          <div class="buttons">
            <button
              type="submit"
              form="settings"
              class="primary"
              disabled={busy !== null}
            >
              {busy === 'copy' ? (
                <span class="spinner" />
              ) : (
                <Icon name={copied ? 'check' : 'copy'} />
              )}
              {copied ? 'Copied' : 'Copy link'}
            </button>
            {forStremio && (
              <button
                type="button"
                class="secondary"
                disabled={busy !== null}
                onClick={() => void run('stremio')}
              >
                Install in Stremio
              </button>
            )}
          </div>
          <p class="next">
            Add it in AIOStreams as a custom addon: paste the link as its
            manifest URL.
          </p>
        </div>
      </main>
    </div>
  );
}

render(<App />, document.getElementById('app')!);
