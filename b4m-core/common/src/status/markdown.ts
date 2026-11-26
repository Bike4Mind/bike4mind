import { classifyLink, type LinkPolicyOptions } from './linkPolicy';

export type MarkdownInline =
  | { type: 'text'; value: string }
  | { type: 'break' }
  | { type: 'code'; value: string }
  | { type: 'strong'; children: MarkdownInline[] }
  | { type: 'em'; children: MarkdownInline[] }
  | { type: 'link'; href: string; host: string; children: MarkdownInline[] };

export type MarkdownBlock =
  | { type: 'paragraph'; children: MarkdownInline[] }
  | { type: 'list'; ordered: false; items: MarkdownInline[][] }
  | { type: 'list'; ordered: true; start: number; items: MarkdownInline[][] };

type PendingList = { ordered: false; items: string[][] } | { ordered: true; start: number; items: string[][] };

export const MAX_MARKDOWN_PARSE_CHARS = 200_000;
const MAX_INLINE_DEPTH = 3;

// C0 and C1 controls except newline, bidi controls and zero-width characters.
// eslint-disable-next-line no-control-regex
const STRIPPED_CHARS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** NFC, then drop controls (newline kept), bidi controls and zero-width characters. */
export function normalizePublicText(input: string): string {
  return input.replace(/\r\n?/g, '\n').normalize('NFC').replace(STRIPPED_CHARS, '');
}

const ESCAPABLE = new Set(['\\', '*', '_', '`', '[', ']', '(', ')', '-', '+', '.', '!', '#', '<', '>']);
// The lookahead makes the run of spaces atomic, so a trailing line terminator cannot trigger backtracking.
const UNORDERED_MARKER = /^[-*+] +(?=[^ ]|$)([\s\S]*)$/;
const ORDERED_MARKER = /^(\d{1,9})\. +(?=[^ ]|$)([\s\S]*)$/;

function text(value: string): MarkdownInline {
  return { type: 'text', value };
}

function pushText(nodes: MarkdownInline[], value: string): void {
  if (value === '') return;
  const last = nodes[nodes.length - 1];
  if (last && last.type === 'text') last.value += value;
  else nodes.push(text(value));
}

function pushAll(nodes: MarkdownInline[], more: MarkdownInline[]): void {
  for (const node of more) {
    if (node.type === 'text') pushText(nodes, node.value);
    else nodes.push(node);
  }
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
}

function findClosingDelimiter(source: string, from: number, delimiter: string): number {
  for (let i = from; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '`') {
      const end = source.indexOf('`', i + 1);
      if (end === -1) continue;
      i = end;
      continue;
    }
    if (source.startsWith(delimiter, i)) return i;
  }
  return -1;
}

function closingParentheses(source: string): Map<number, number> {
  const closes = new Map<number, number>();
  const opens: number[] = [];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '(') opens.push(index);
    else if (source[index] === ')') {
      const open = opens.pop();
      if (open !== undefined) closes.set(open, index);
    }
  }
  return closes;
}

function parseInline(source: string, options: LinkPolicyOptions, depth: number, inLink: boolean): MarkdownInline[] {
  const out: MarkdownInline[] = [];
  if (depth >= MAX_INLINE_DEPTH) {
    pushText(out, source);
    return out;
  }

  const closes = closingParentheses(source);
  let i = 0;
  while (i < source.length) {
    const ch = source[i];

    if (ch === '\\' && i + 1 < source.length && ESCAPABLE.has(source[i + 1])) {
      pushText(out, source[i + 1]);
      i += 2;
      continue;
    }

    if (ch === '`') {
      const end = source.indexOf('`', i + 1);
      if (end > i + 1) {
        out.push({ type: 'code', value: source.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    if (ch === '!' && source[i + 1] === '[') {
      const image = matchLink(source, i + 1, closes);
      if (image) {
        pushText(out, source.slice(i, image.end));
        i = image.end;
        continue;
      }
    }

    if (ch === '[' && !inLink) {
      const link = matchLink(source, i, closes);
      if (link) {
        const children = parseInline(link.label, options, depth + 1, true);
        const decision = classifyLink(link.href, options);
        if (decision.allowed)
          out.push({ type: 'link', href: encodeParens(decision.href), host: decision.host, children });
        else pushAll(out, children);
        i = link.end;
        continue;
      }
    }

    if (source.startsWith('**', i)) {
      const end = findClosingDelimiter(source, i + 2, '**');
      if (end > i + 2) {
        out.push({ type: 'strong', children: parseInline(source.slice(i + 2, end), options, depth + 1, inLink) });
        i = end + 2;
        continue;
      }
    }

    if ((ch === '*' || ch === '_') && source[i + 1] !== ' ' && source[i + 1] !== ch) {
      const standalone = ch === '*' || !isWordChar(source[i - 1]);
      if (standalone) {
        const end = findClosingDelimiter(source, i + 1, ch);
        const closes = end > i + 1 && source[end - 1] !== ' ' && (ch === '*' || !isWordChar(source[end + 1]));
        if (closes) {
          out.push({ type: 'em', children: parseInline(source.slice(i + 1, end), options, depth + 1, inLink) });
          i = end + 1;
          continue;
        }
      }
    }

    pushText(out, ch);
    i++;
  }
  return out;
}

function encodeParens(href: string): string {
  return href.replace(/\(/g, '%28').replace(/\)/g, '%29');
}

function matchLink(
  source: string,
  start: number,
  closes: ReadonlyMap<number, number>
): { label: string; href: string; end: number } | null {
  let i = start + 1;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '[') return null;
    if (ch === ']') break;
  }
  if (i >= source.length || source[i + 1] !== '(') return null;
  const close = closes.get(i + 1);
  if (close === undefined) return null;
  const label = source.slice(start + 1, i);
  if (label === '') return null;
  return { label, href: source.slice(i + 2, close), end: close + 1 };
}

// A line left blank once a disallowed link lost its label would split the paragraph when stored, so
// such lines are dropped; the first line also loses leading spaces, which a list marker would eat.
function joinParsed(lines: MarkdownInline[][]): MarkdownInline[] {
  const out: MarkdownInline[] = [];
  for (const parsed of lines) {
    const first = parsed[0];
    const line: MarkdownInline[] =
      out.length === 0 && first?.type === 'text'
        ? [{ type: 'text', value: first.value.trimStart() }, ...parsed.slice(1)]
        : parsed;
    if (line.every(node => node.type === 'text' && node.value.trim() === '')) continue;
    if (out.length > 0) out.push({ type: 'break' });
    pushAll(out, line);
  }
  return out;
}

function joinLines(lines: string[], options: LinkPolicyOptions): MarkdownInline[] {
  return joinParsed(lines.map(line => parseInline(line, options, 0, false)));
}

function parseBlocks(source: string, options: LinkPolicyOptions): MarkdownBlock[] {
  const lines = normalizePublicText(source.slice(0, MAX_MARKDOWN_PARSE_CHARS)).split('\n');
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let list: PendingList | null = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      const children = joinLines(paragraph, options);
      if (children.length > 0) blocks.push({ type: 'paragraph', children });
    }
    paragraph = [];
  };
  const flushList = () => {
    if (list) blocks.push({ ...list, type: 'list', items: list.items.map(item => joinLines(item, options)) });
    list = null;
  };

  for (const line of lines) {
    if (line.trim() === '') {
      flushParagraph();
      flushList();
      continue;
    }
    const unordered = UNORDERED_MARKER.exec(line);
    const ordered = unordered ? null : ORDERED_MARKER.exec(line);
    const marker = unordered ?? ordered;
    if (marker) {
      if (ordered && Number(ordered[1]) !== 1 && paragraph.length > 0) {
        paragraph.push(line);
        continue;
      }
      flushParagraph();
      const isOrdered = ordered !== null;
      if (list && list.ordered !== isOrdered) flushList();
      if (!list)
        list = ordered ? { ordered: true, start: Number(ordered[1]), items: [] } : { ordered: false, items: [] };
      list.items.push([ordered ? ordered[2] : marker[1]]);
      continue;
    }
    if (list) list.items[list.items.length - 1].push(line);
    else paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return blocks;
}

function unwrapInline(nodes: MarkdownInline[], kinds: ReadonlySet<string>): MarkdownInline[] {
  const out: MarkdownInline[] = [];
  for (const node of nodes) {
    if (node.type === 'strong' || node.type === 'em' || node.type === 'link') {
      const children = unwrapInline(node.children, kinds);
      if (kinds.has(node.type)) pushAll(out, children);
      else out.push({ ...node, children });
    } else if (node.type === 'text') pushText(out, node.value);
    else out.push(node);
  }
  return out;
}

function relinked(nodes: MarkdownInline[]): MarkdownInline[] {
  const lines: MarkdownInline[][] = [[]];
  for (const node of nodes) {
    if (node.type === 'break') lines.push([]);
    else lines[lines.length - 1].push(node);
  }
  return joinParsed(lines);
}

function unwrapBlocks(blocks: MarkdownBlock[], kinds: ReadonlySet<string>): MarkdownBlock[] {
  const out: MarkdownBlock[] = [];
  for (const block of blocks) {
    if (block.type === 'list') {
      out.push({ ...block, items: block.items.map(item => relinked(unwrapInline(item, kinds))) });
    } else {
      const children = relinked(unwrapInline(block.children, kinds));
      if (children.length > 0) out.push({ ...block, children });
    }
  }
  return out;
}

/** The serialization that parses back to exactly these blocks, or null when no spelling does. */
function stableSerialization(blocks: MarkdownBlock[], options: LinkPolicyOptions): string | null {
  const expected = JSON.stringify(blocks);
  for (const swap of [false, true]) {
    const candidate = serializeMarkdown(blocks, swap);
    if (JSON.stringify(parseBlocks(candidate, options)) === expected) return candidate;
  }
  return null;
}

/**
 * Mini-markdown subset: paragraphs, line breaks, bold, italic, inline code, lists and links. Everything
 * else (headings, images, raw HTML) stays literal text. Links survive only when the policy allows them.
 * Emphasis that cannot be written back unchanged is shown as plain text, so stored text is a fixed point.
 */
export function parseMarkdown(source: string, options: LinkPolicyOptions): MarkdownBlock[] {
  let blocks = parseBlocks(source, options);
  if (stableSerialization(blocks, options) !== null) return blocks;
  for (const kinds of [new Set(['em']), new Set(['em', 'strong'])]) {
    blocks = unwrapBlocks(blocks, kinds);
    if (stableSerialization(blocks, options) !== null) break;
  }
  return blocks;
}

function escapeText(value: string): string {
  return value.replace(/[\\*_`[\]]/g, match => `\\${match}`);
}

function escapeLineStart(value: string): string {
  if (/^[-+] /.test(value)) return `\\${value}`;
  return value.replace(/^(\d{1,9})\. /, '$1\\. ');
}

function hasEmphasis(nodes: MarkdownInline[], only?: 'strong'): boolean {
  return nodes.some(
    node =>
      node.type === 'strong' ||
      (node.type === 'em' && only === undefined) ||
      (node.type === 'em' && hasEmphasis(node.children, only)) ||
      (node.type === 'link' && hasEmphasis(node.children, only))
  );
}

type SerializeParent = 'strong' | 'em' | null;

// A single-asterisk closer stops at the first asterisk inside, so an em holding other emphasis, or
// closing a strong, uses underscores. `swap` is the second try: asterisks outside, underscores inside.
function serializeInline(nodes: MarkdownInline[], parent: SerializeParent, swap: boolean): string {
  let out = '';
  let lineStart = true;
  for (const [index, node] of nodes.entries()) {
    switch (node.type) {
      case 'text': {
        let escaped = escapeText(node.value);
        if (nodes[index + 1]?.type === 'link' && escaped.endsWith('!')) {
          escaped = `${escaped.slice(0, -1)}\\!`;
        }
        out += lineStart ? escapeLineStart(escaped) : escaped;
        lineStart = false;
        break;
      }
      case 'break':
        out += '\n';
        lineStart = true;
        continue;
      case 'code':
        out += `\`${node.value}\``;
        break;
      case 'strong':
        out += `**${serializeInline(node.children, 'strong', swap)}**`;
        break;
      case 'em': {
        const closesStrong = parent === 'strong' && index === nodes.length - 1;
        const mark =
          closesStrong || (swap ? parent === 'em' || hasEmphasis(node.children, 'strong') : hasEmphasis(node.children))
            ? '_'
            : '*';
        out += `${mark}${serializeInline(node.children, 'em', swap)}${mark}`;
        break;
      }
      case 'link':
        out += `[${serializeInline(node.children, null, swap)}](${node.href})`;
        break;
    }
    lineStart = false;
  }
  return out;
}

export function serializeMarkdown(blocks: MarkdownBlock[], swap = false): string {
  return blocks
    .map(block =>
      block.type === 'paragraph'
        ? serializeInline(block.children, null, swap)
        : block.items
            .map(
              (item, index) =>
                `${block.ordered ? `${Math.min(block.start + index, 999_999_999)}.` : '-'} ${serializeInline(item, null, swap)}`
            )
            .join('\n')
    )
    .join('\n\n');
}

/** Normalizes and re-serializes, so a stored body parses to exactly what the public page shows. */
export function sanitizeMarkdown(source: string, options: LinkPolicyOptions): string {
  return sanitizeParsedMarkdown(parseMarkdown(source, options), options);
}

/** The serializing half of `sanitizeMarkdown`, for callers that already hold the parsed blocks. */
export function sanitizeParsedMarkdown(blocks: MarkdownBlock[], options: LinkPolicyOptions): string {
  return stableSerialization(blocks, options) ?? serializeMarkdown(blocks);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderInlineHtml(nodes: MarkdownInline[]): string {
  return nodes
    .map(node => {
      switch (node.type) {
        case 'text':
          return escapeHtml(node.value);
        case 'break':
          return '<br />';
        case 'code':
          return `<code>${escapeHtml(node.value)}</code>`;
        case 'strong':
          return `<strong>${renderInlineHtml(node.children)}</strong>`;
        case 'em':
          return `<em>${renderInlineHtml(node.children)}</em>`;
        case 'link':
          return `<a href="${escapeHtml(node.href)}" rel="noopener noreferrer nofollow">${renderInlineHtml(node.children)}</a> (${escapeHtml(node.host)})`;
      }
    })
    .join('');
}

export function renderMarkdownHtml(blocks: MarkdownBlock[]): string {
  return blocks
    .map(block => {
      if (block.type === 'paragraph') return `<p>${renderInlineHtml(block.children)}</p>`;
      const tag = block.ordered ? 'ol' : 'ul';
      const start = block.ordered && block.start !== 1 ? ` start="${block.start}"` : '';
      return `<${tag}${start}>${block.items.map(item => `<li>${renderInlineHtml(item)}</li>`).join('')}</${tag}>`;
    })
    .join('');
}

function renderInlineText(nodes: MarkdownInline[]): string {
  return nodes
    .map(node => {
      switch (node.type) {
        case 'text':
        case 'code':
          return node.value;
        case 'break':
          return '\n';
        case 'strong':
        case 'em':
          return renderInlineText(node.children);
        case 'link':
          return `${renderInlineText(node.children)} (${node.host})`;
      }
    })
    .join('');
}

export function renderMarkdownText(blocks: MarkdownBlock[]): string {
  return blocks
    .map(block =>
      block.type === 'paragraph'
        ? renderInlineText(block.children)
        : block.items
            .map((item, index) => `${block.ordered ? `${block.start + index}.` : '-'} ${renderInlineText(item)}`)
            .join('\n')
    )
    .join('\n\n');
}

type OpenToken = { kind: 'link' | 'strong' | 'em' | 'code'; mark: string; at: number };

const MAX_CLOSED_TOKENS = 8;

// Tokens still open at the end of a serialized prefix. Serialized text escapes every literal delimiter,
// so each bare one is a token edge. `end` stops short of a split escape.
function scanOpenTokens(prefix: string): { end: number; open: OpenToken[] } {
  let open: OpenToken[] = [];
  let inUrl = false;
  for (let i = 0; i < prefix.length; i++) {
    const ch = prefix[i];
    const top = open[open.length - 1];
    if (ch === '\n') {
      open = [];
      inUrl = false;
    } else if (top?.kind === 'code') {
      if (ch === '`') open.pop();
    } else if (top?.kind === 'link' && inUrl) {
      if (ch === ')') {
        open.pop();
        inUrl = false;
      }
    } else if (ch === '\\') {
      if (i + 1 >= prefix.length) return { end: i, open };
      if (ESCAPABLE.has(prefix[i + 1])) i++;
    } else if (ch === '`') {
      open.push({ kind: 'code', mark: ch, at: i });
    } else if (ch === '[') {
      if (!open.some(node => node.kind === 'link')) open.push({ kind: 'link', mark: ch, at: i });
    } else if (ch === ']' && top?.kind === 'link' && prefix[i + 1] === '(') {
      inUrl = true;
      i++;
    } else if (prefix.startsWith('**', i)) {
      if (top?.kind === 'strong') open.pop();
      else open.push({ kind: 'strong', mark: '**', at: i });
      i++;
    } else if (ch === '*' || ch === '_') {
      if (top?.kind === 'em' && top.mark === ch) open.pop();
      else open.push({ kind: 'em', mark: ch, at: i });
    }
  }
  return { end: prefix.length, open };
}

const codePoints = (value: string) => Array.from(value).length;

/**
 * Ends a cut prefix at a token boundary and marks the cut with an ellipsis. Open emphasis and code
 * are closed so the text before the cut survives; a link cut short is dropped whole.
 */
export function closeTruncatedMarkdown(prefix: string): string {
  let room = prefix;
  for (;;) {
    const { end, open } = scanOpenTokens(room);
    let body = room.slice(0, end);
    let kept = open;
    const link = open.findIndex(node => node.kind === 'link');
    if (link !== -1) {
      body = body.slice(0, open[link].at);
      kept = open.slice(0, link);
    }
    if (kept.length > MAX_CLOSED_TOKENS) {
      body = body.slice(0, kept[0].at);
      kept = [];
    }
    body = body.trimEnd();
    while (kept.length > 0) {
      const top = kept[kept.length - 1];
      if (body.length > top.at + top.mark.length) break;
      body = body.slice(0, top.at).trimEnd();
      kept = kept.slice(0, -1);
    }
    const closers = kept
      .map(node => node.mark)
      .reverse()
      .join('');
    const over = Math.max(
      body.length + closers.length - prefix.length,
      codePoints(body) + closers.length - codePoints(prefix)
    );
    if (over <= 0) return `${body}${closers}…`;
    room = Array.from(body).slice(0, -over).join('');
  }
}

/** Cuts to at most `max` code points, never inside a markdown token, marking the cut with an ellipsis. */
export function truncateMarkdown(source: string, max: number): { text: string; truncated: boolean } {
  const chars = Array.from(source);
  if (chars.length <= max) return { text: source, truncated: false };
  if (max <= 1) return { text: '\u2026'.slice(0, max), truncated: true };
  return { text: closeTruncatedMarkdown(chars.slice(0, max - 1).join('')), truncated: true };
}
