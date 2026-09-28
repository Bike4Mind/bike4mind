import { describe, expect, it } from 'vitest';
import { ARTIFACT_ATTRS_PATTERN, ClaudeArtifactMimeTypes } from '../types/entities/ArtifactTypes';
import {
  ARTIFACT_DELIVERED_PLACEHOLDER,
  TOOL_ARTIFACT_EMITTERS,
  filterToolArtifactMarkup,
  parseToolArtifactAttributes,
  stripDeliveredArtifactBlocks,
  stripToolArtifactMarkup,
} from './toolArtifactEmitters';

// The regex-based implementations these functions replaced, kept as the differential oracle.
function oldFilter(toolName: string, text: string): string | null {
  const allowedType = TOOL_ARTIFACT_EMITTERS.get(toolName);
  if (allowedType === undefined) return null;
  const opener = /<artifact\b/gi;
  const openTag = new RegExp(`<artifact\\s(${ARTIFACT_ATTRS_PATTERN})>`, 'iy');
  const closer = /<\/artifact>/gi;
  let out = '';
  let cursor = 0;
  let kept = 0;
  for (let open = opener.exec(text); open; open = opener.exec(text)) {
    openTag.lastIndex = open.index;
    const tag = openTag.exec(text);
    if (!tag) return null;
    const bodyStart = openTag.lastIndex;
    closer.lastIndex = bodyStart;
    const close = closer.exec(text);
    if (!close) return null;
    const keep = parseToolArtifactAttributes(tag[1]).type === allowedType;
    if (keep) {
      if (/<artifact\b/i.test(text.slice(bodyStart, close.index))) return null;
      kept++;
    }
    out += text.slice(cursor, open.index) + (keep ? text.slice(open.index, closer.lastIndex) : '');
    cursor = closer.lastIndex;
    opener.lastIndex = cursor;
  }
  return kept > 0 ? out + text.slice(cursor) : null;
}

function oldStrip(text: string, placeholder: string): string {
  const opener = /<artifact\b/gi;
  const openTag = new RegExp(`<artifact\\s(?:${ARTIFACT_ATTRS_PATTERN})>`, 'iy');
  const closer = /<\/artifact>/gi;
  let out = '';
  let cursor = 0;
  for (let open = opener.exec(text); open; open = opener.exec(text)) {
    out += text.slice(cursor, open.index) + placeholder;
    openTag.lastIndex = open.index;
    if (!openTag.exec(text)) return out;
    closer.lastIndex = openTag.lastIndex;
    if (!closer.exec(text)) return out;
    cursor = closer.lastIndex;
    opener.lastIndex = cursor;
  }
  return out + text.slice(cursor);
}

function oldExtractIdentifiers(markup: string): Set<string> {
  const ids = new Set<string>();
  const openTag = new RegExp(`<artifact\\s(${ARTIFACT_ATTRS_PATTERN})>`, 'gi');
  for (const match of markup.matchAll(openTag)) {
    const identifier = parseToolArtifactAttributes(match[1]).identifier;
    if (identifier !== undefined) ids.add(identifier);
  }
  return ids;
}

function oldStripDelivered(text: string, deliveredMarkup: string): string {
  const deliveredIdentifiers = oldExtractIdentifiers(deliveredMarkup);
  if (deliveredIdentifiers.size === 0) return text;
  const opener = /<artifact\b/gi;
  const openTag = new RegExp(`<artifact\\s(${ARTIFACT_ATTRS_PATTERN})>`, 'iy');
  const closer = /<\/artifact>/gi;
  let out = '';
  let cursor = 0;
  for (let open = opener.exec(text); open; open = opener.exec(text)) {
    if (!/\s/.test(text[open.index + 9] ?? '')) {
      opener.lastIndex = open.index + 1;
      continue;
    }
    openTag.lastIndex = open.index;
    const tag = openTag.exec(text);
    if (!tag) {
      break;
    }
    closer.lastIndex = openTag.lastIndex;
    const close = closer.exec(text);
    if (!close) {
      break;
    }
    const identifier = parseToolArtifactAttributes(tag[1]).identifier;
    const remove = identifier !== undefined && deliveredIdentifiers.has(identifier);
    out += text.slice(cursor, open.index) + (remove ? '' : text.slice(open.index, closer.lastIndex));
    cursor = closer.lastIndex;
    opener.lastIndex = cursor;
  }
  return out + text.slice(cursor);
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RECHARTS = ClaudeArtifactMimeTypes.RECHARTS;
const ALPHABET = [
  '<artifact',
  '<ARTIFACT',
  '<artifactx',
  '</artifact>',
  '</Artifact>',
  ' ',
  '\n',
  '\u00a0',
  '>',
  '"',
  "'",
  'x',
  `type="${RECHARTS}"`,
  "type='text/html'",
  'identifier="a"',
  "identifier='b'",
  '<artifact type="x">',
];

function randomText(rand: () => number): string {
  const len = 1 + Math.floor(rand() * 16);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return s;
}

const MIN_BASELINE_MS = 25;

function bestMs(fn: () => void): number {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    fn();
    best = Math.min(best, performance.now() - t);
  }
  return best;
}

function expectLinear(build: (n: number) => string, run: (s: string) => unknown) {
  const [ta, tb, tc] = [20_000, 40_000, 80_000].map(n => {
    const input = build(n);
    return bestMs(() => run(input));
  });
  expect(tb / Math.max(ta, MIN_BASELINE_MS)).toBeLessThan(3);
  expect(tc / Math.max(tb, MIN_BASELINE_MS)).toBeLessThan(3);
}

describe('toolArtifactEmitters linear scan', () => {
  it('matches the regex implementations on seeded fuzz input', () => {
    const rand = mulberry32(7);
    expect(TOOL_ARTIFACT_EMITTERS.get('recharts')).toBe(RECHARTS);
    for (let i = 0; i < 5000; i++) {
      const text = randomText(rand);
      const delivered = randomText(rand);
      expect(filterToolArtifactMarkup('recharts', text)).toBe(oldFilter('recharts', text));
      expect(stripToolArtifactMarkup(text, ARTIFACT_DELIVERED_PLACEHOLDER)).toBe(
        oldStrip(text, ARTIFACT_DELIVERED_PLACEHOLDER)
      );
      expect(stripDeliveredArtifactBlocks(text, delivered)).toBe(oldStripDelivered(text, delivered));
      expect(stripDeliveredArtifactBlocks(text, text)).toBe(oldStripDelivered(text, text));
    }
  });

  it.each([
    ['repeated unclosed opener', (n: number) => '<artifact a '.repeat(n)],
    ['repeated closed opener', (n: number) => '<artifact a>'.repeat(n)],
    ['repeated unclosed quote', (n: number) => '<artifact a="'.repeat(n)],
  ])('runs in linear time on a %s', (_label, build) => {
    expectLinear(build, text => {
      filterToolArtifactMarkup('recharts', text);
      stripToolArtifactMarkup(text, ARTIFACT_DELIVERED_PLACEHOLDER);
      stripDeliveredArtifactBlocks(text, text);
    });
  });
});
