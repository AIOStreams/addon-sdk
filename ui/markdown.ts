/**
 * Basic Markdown for the configure page's text: field titles and descriptions,
 * the manifest's description and the footer. Text is parsed into
 * nodes, never HTML, and only http(s) and mailto addresses become links.
 */

export type Inline =
  | string
  | { type: 'strong' | 'em' | 'del'; children: Inline[] }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; children: Inline[] }
  | { type: 'image'; src: string; alt: string }
  | { type: 'br' };

export type Block =
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'heading'; level: 1 | 2 | 3; children: Inline[] }
  | { type: 'list'; ordered: boolean; start: number; items: Inline[][] };

const ESCAPABLE = /[!-/:-@[-`{-~]/;
const SAFE_LINK = /^(https?:\/\/|mailto:)/i;
const SAFE_IMAGE = /^https?:\/\//i;
const WORD = /[\p{L}\p{N}]/u;
const SPACE = /\s/;
const BARE_URL = /^https?:\/\/[^\s<>]+/i;
const ANGLE_URL = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i;

const runLength = (text: string, at: number) => {
  let end = at;
  while (text[end] === text[at]) end++;
  return end - at;
};

function codeSpan(text: string, at: number) {
  if (text[at] !== '`') return null;
  const run = runLength(text, at);
  for (let i = at + run; i < text.length;) {
    const found = text.indexOf('`', i);
    if (found < 0) return null;
    const length = runLength(text, found);
    if (length === run) {
      const content = text.slice(at + run, found).replace(/\n/g, ' ');
      const padded = /^ (?=.*[^ ]).* $/s.test(content);
      return {
        text: padded ? content.slice(1, -1) : content,
        end: found + run,
      };
    }
    i = found + length;
  }
  return null;
}

function matching(text: string, open: number) {
  const [opener, closer] = text[open] === '[' ? '[]' : '()';
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const char = text[i];
    if (char === '\\') i++;
    else if (char === '`') i = (codeSpan(text, i)?.end ?? i + 1) - 1;
    else if (char === opener) depth++;
    else if (char === closer && --depth === 0) return i;
  }
  return -1;
}

function linkAt(text: string, at: number, inLink: boolean) {
  const image = text[at] === '!' && text[at + 1] === '[';
  if (!image && (text[at] !== '[' || inLink)) return null;
  const open = image ? at + 1 : at;
  const close = matching(text, open);
  if (close < 0 || text[close + 1] !== '(') return null;
  const end = matching(text, close + 1);
  if (end < 0) return null;
  const label = text.slice(open + 1, close);
  const url = text
    .slice(close + 2, end)
    .trim()
    .split(/\s+/)[0]
    .replace(/^<(.*)>$/, '$1');
  if (image) {
    const alt = plainText(parseInline(label, true));
    const node: Inline = SAFE_IMAGE.test(url)
      ? { type: 'image', src: url, alt }
      : alt;
    return { nodes: [node], end: end + 1 };
  }
  const children = parseInline(label, true);
  return {
    nodes: SAFE_LINK.test(url)
      ? [{ type: 'link', href: url, children } as Inline]
      : children,
    end: end + 1,
  };
}

function trimUrl(url: string): string {
  const trimmed = url.replace(/[.,:;!?'"*_~]+$/, '');
  const unopened =
    trimmed.endsWith(')') &&
    trimmed.split(')').length > trimmed.split('(').length;
  return unopened ? trimUrl(trimmed.slice(0, -1)) : trimmed;
}

function autolinkAt(text: string, at: number) {
  const angled = ANGLE_URL.exec(text.slice(at, at + 2048));
  if (angled) {
    const href = angled[1];
    const label = href.replace(/^mailto:/i, '');
    return { href, label, end: at + angled[0].length };
  }
  if (at > 0 && (WORD.test(text[at - 1]) || text[at - 1] === '/')) return null;
  const found = BARE_URL.exec(text.slice(at, at + 2048))?.[0];
  if (!found) return null;
  const url = trimUrl(found);
  return { href: url, label: url, end: at + url.length };
}

function emphasisAt(text: string, at: number, inLink: boolean) {
  const char = text[at];
  const run = runLength(text, at);
  if (char === '~' ? run !== 2 : run > 3) return null;
  const after = text[at + run];
  if (after === undefined || SPACE.test(after)) return null;
  if (char === '_' && at > 0 && WORD.test(text[at - 1])) return null;

  for (let i = at + run; i < text.length;) {
    const here = text[i];
    if (here === '\\') {
      i += 2;
      continue;
    }
    const code = codeSpan(text, i);
    const link = here === '[' || here === '!' ? linkAt(text, i, inLink) : null;
    if (code || link) {
      i = (code ?? link)!.end;
      continue;
    }
    if (here !== char) {
      i++;
      continue;
    }
    const length = runLength(text, i);
    const closes =
      length === run &&
      !SPACE.test(text[i - 1]) &&
      !(char === '_' && WORD.test(text[i + length] ?? ''));
    if (closes) {
      const children = parseInline(text.slice(at + run, i), inLink);
      const node: Inline =
        char === '~'
          ? { type: 'del', children }
          : run === 1
            ? { type: 'em', children }
            : run === 2
              ? { type: 'strong', children }
              : { type: 'strong', children: [{ type: 'em', children }] };
      return { node, end: i + length };
    }
    i += length;
  }
  return null;
}

export function parseInline(text: string, inLink = false): Inline[] {
  const out: Inline[] = [];
  let plain = '';
  const push = (...nodes: Inline[]) => {
    if (plain) out.push(plain);
    plain = '';
    out.push(...nodes);
  };

  for (let i = 0; i < text.length;) {
    const char = text[i];
    if (char === '\\' && ESCAPABLE.test(text[i + 1] ?? '')) {
      plain += text[i + 1];
      i += 2;
    } else if (char === '\n') {
      push({ type: 'br' });
      i++;
    } else if (char === '`') {
      const code = codeSpan(text, i);
      const run = runLength(text, i);
      if (code) push({ type: 'code', text: code.text });
      else plain += text.slice(i, i + run);
      i = code ? code.end : i + run;
    } else if (char === '*' || char === '_' || char === '~') {
      const emphasis = emphasisAt(text, i, inLink);
      const run = runLength(text, i);
      if (emphasis) push(emphasis.node);
      else plain += text.slice(i, i + run);
      i = emphasis ? emphasis.end : i + run;
    } else {
      const link =
        char === '[' || char === '!' ? linkAt(text, i, inLink) : null;
      const auto =
        link || inLink || (char !== '<' && char !== 'h' && char !== 'H')
          ? null
          : autolinkAt(text, i);
      if (link) {
        push(...link.nodes);
        i = link.end;
      } else if (auto) {
        push({ type: 'link', href: auto.href, children: [auto.label] });
        i = auto.end;
      } else {
        plain += char;
        i++;
      }
    }
  }
  if (plain) out.push(plain);
  return out;
}

const HEADING = /^ {0,3}(#{1,3})[ \t]+(.+?)(?:[ \t]+#+)?$/;
const BULLET = /^[ \t]*[-*+][ \t]+(.*)$/;
const NUMBERED = /^[ \t]*(\d{1,9})[.)][ \t]+(.*)$/;

export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let lines: string[] = [];
  let list: { ordered: boolean; start: number; items: string[][] } | null =
    null;
  const close = () => {
    if (lines.length) {
      blocks.push({
        type: 'paragraph',
        children: parseInline(lines.join('\n')),
      });
    }
    if (list) {
      blocks.push({
        type: 'list',
        ordered: list.ordered,
        start: list.start,
        items: list.items.map((item) => parseInline(item.join('\n'))),
      });
    }
    lines = [];
    list = null;
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const heading = HEADING.exec(line);
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (!line) {
      close();
    } else if (heading) {
      close();
      blocks.push({
        type: 'heading',
        level: heading[1].length as 1 | 2 | 3,
        children: parseInline(heading[2]),
      });
    } else if (bullet || numbered) {
      const ordered = !!numbered;
      if (lines.length || (list && list.ordered !== ordered)) close();
      list ??= {
        ordered,
        start: numbered ? Number(numbered[1]) : 1,
        items: [],
      };
      list.items.push([bullet ? bullet[1] : numbered![2]]);
    } else if (list && /^[ \t]/.test(line)) {
      list.items.at(-1)!.push(line.trim());
    } else {
      if (list) close();
      lines.push(line.trim());
    }
  }
  close();
  return blocks;
}

export function plainText(nodes: Inline[]): string {
  return nodes
    .map((node) =>
      typeof node === 'string'
        ? node
        : node.type === 'br'
          ? ' '
          : node.type === 'code'
            ? node.text
            : node.type === 'image'
              ? node.alt
              : plainText(node.children)
    )
    .join('');
}

export const plain = (text: string) => plainText(parseInline(text));
