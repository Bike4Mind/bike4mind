import { describe, expect, it } from 'vitest';
import { expectLinearGrowth } from '../__tests__/expectLinearGrowth';
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

// At 10k the old regexes' baseline is already hundreds of ms, the linear scans a few ms.
const GROWTH_SMALL_N = 10_000;

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
    expectLinearGrowth(
      build,
      text => {
        filterToolArtifactMarkup('recharts', text);
        stripToolArtifactMarkup(text, ARTIFACT_DELIVERED_PLACEHOLDER);
        stripDeliveredArtifactBlocks(text, text);
      },
      GROWTH_SMALL_N
    );
  });
});

const CHESS_ARTIFACT =
  '<artifact identifier="game-1" type="application/vnd.ant.chess" title="Chess Game">{"fen":"8/8/8/8/8/8/8/8 w - - 0 1"}</artifact>';
const MERMAID_ARTIFACT =
  '<artifact identifier="flow" type="application/vnd.ant.mermaid" title="Flow">graph TD; A-->B</artifact>';

describe('stripToolArtifactMarkup: the model never sees tool artifact markup it could echo', () => {
  const P = '[removed]';

  it('replaces every block, keeps surrounding text, and leaves markup-free text untouched', () => {
    expect(stripToolArtifactMarkup(`a ${CHESS_ARTIFACT} b ${MERMAID_ARTIFACT} c`, P)).toBe(`a ${P} b ${P} c`);
    expect(stripToolArtifactMarkup('plain <artifacts> text', P)).toBe('plain <artifacts> text');
    expect(stripToolArtifactMarkup('', P)).toBe('');
  });

  it('removes a block whose quoted attribute holds ">" and a case-varied tag', () => {
    const tricky = '<ARTIFACT title="a>b" type="text/html"><script>x</script></Artifact>';
    expect(stripToolArtifactMarkup(`x${tricky}y`, P)).toBe(`x${P}y`);
  });

  it('breaks an unclosed opener and a nested opener so no tag survives', () => {
    const out = stripToolArtifactMarkup('<artifact type="text/html">open <artifact type="x">in</artifact> tail', P);
    expect(out).not.toMatch(/<artifact/i);
    expect(stripToolArtifactMarkup('ok <artifact type="text/html"><!DOCTYPE html><html></html>', P)).toBe(`ok ${P}`);
    expect(stripToolArtifactMarkup('<artifact>bare</artifact> tail', P)).toBe(P);
  });

  it('does not let a quoted closer inside the open tag end the block early', () => {
    const quoted = '<artifact title="</artifact>" type="text/html"><html><script>x</script></html></artifact>';
    expect(stripToolArtifactMarkup(`a ${quoted} b`, P)).toBe(`a ${P} b`);
  });

  it('strips pathological output in linear time', () => {
    const started = Date.now();
    stripToolArtifactMarkup('<artifact '.repeat(100_000), P);
    stripToolArtifactMarkup(`${'<artifact>'.repeat(50_000)}</artifact>`, P);
    stripToolArtifactMarkup(CHESS_ARTIFACT.repeat(20_000), P);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('stripDeliveredArtifactBlocks: the recursive-reply guard only removes an echo of an already-delivered artifact', () => {
  it('removes a block whose identifier was already delivered, keeps everything else', () => {
    expect(stripDeliveredArtifactBlocks(`a ${CHESS_ARTIFACT} b ${MERMAID_ARTIFACT} c`, CHESS_ARTIFACT)).toBe(
      `a  b ${MERMAID_ARTIFACT} c`
    );
    expect(stripDeliveredArtifactBlocks('plain <artifacts> text', CHESS_ARTIFACT)).toBe('plain <artifacts> text');
    expect(stripDeliveredArtifactBlocks('', CHESS_ARTIFACT)).toBe('');
  });

  it('pin: keeps a genuinely NEW artifact the model composes in its own reply - a different identifier is not an echo', () => {
    expect(stripDeliveredArtifactBlocks(MERMAID_ARTIFACT, CHESS_ARTIFACT)).toBe(MERMAID_ARTIFACT);
  });

  it('is a no-op when nothing has been delivered yet this turn', () => {
    expect(stripDeliveredArtifactBlocks(`a ${CHESS_ARTIFACT} b`, '')).toBe(`a ${CHESS_ARTIFACT} b`);
  });

  it('keeps a stray, malformed opener literally instead of dropping the rest of the reply', () => {
    // Unlike stripToolArtifactMarkup (built for adversarial tool output), a model's own prose
    // mentioning "<artifact" with no real attributes must not cost the rest of its reply.
    const reply = "I won't repeat the <artifact tag - here's a summary instead.";
    expect(stripDeliveredArtifactBlocks(reply, MERMAID_ARTIFACT)).toBe(reply);
  });

  it('keeps an unclosed (e.g. truncated) block literally instead of dropping the rest of the reply', () => {
    const reply = `Before. ${MERMAID_ARTIFACT.slice(0, -'</artifact>'.length)} After.`;
    expect(stripDeliveredArtifactBlocks(reply, MERMAID_ARTIFACT)).toBe(reply);
  });

  it('removes a real echoed block even when an unrelated stray opener appears earlier in the same text', () => {
    // "<artifact-like" has no whitespace right after "artifact" (a hyphen), so it's rejected in
    // the same O(1) step as a plain word-boundary mismatch - it can never reach into the real
    // tag's own attributes the way "<artifact " (with a space) legitimately can, by the shared
    // grammar ARTIFACT_ATTRS_PATTERN also uses (see the "stray opener WITH trailing whitespace
    // can swallow a later real tag" test below).
    const reply = `See the <artifact-like syntax. ${MERMAID_ARTIFACT} Done.`;
    expect(stripDeliveredArtifactBlocks(reply, MERMAID_ARTIFACT)).toBe('See the <artifact-like syntax.  Done.');
  });

  it('a stray opener WITH trailing whitespace can swallow a later real tag - same grammar as filterToolArtifactMarkup', () => {
    // ARTIFACT_ATTRS_PATTERN matches any run of non->/quote characters, so "<artifact " (with a
    // space) greedily reaches for the next unquoted ">" - including one that belongs to a
    // different, later tag. This mirrors filterToolArtifactMarkup's own documented behavior, not
    // a defect introduced here.
    const reply = `Note the <artifact tag. ${MERMAID_ARTIFACT} Done.`;
    expect(stripDeliveredArtifactBlocks(reply, MERMAID_ARTIFACT)).not.toContain('Flow');
  });

  it('pin: a malformed opener with no ">" of its own still removes the real duplicate it swallows toward, because the identifier survives the swallowed span', () => {
    // When nothing between a malformed opener and a later real duplicate can end the attrs scan
    // early (no unbalanced quote - see the `break` comments in toolArtifactEmitters.ts for the
    // case where one does), it swallows toward the duplicate's own ">" instead of stopping short.
    // Here the swallowed span happens to still contain `identifier="flow"` verbatim, so the parse
    // recovers it and the whole span (malformed opener + real duplicate) is removed.
    const reply = `I won't repeat the <artifact tag with no closing bracket anywhere else, ${MERMAID_ARTIFACT}`;
    expect(stripDeliveredArtifactBlocks(reply, MERMAID_ARTIFACT)).toBe("I won't repeat the ");
  });

  it('an unbalanced quote after a stray opener can strand a later real duplicate unstripped - accepted trade-off, not a defect', () => {
    // Contrast with the test above: here the apostrophe sits AFTER the stray opener, inside the
    // span the attrs scan would otherwise cross to reach the real duplicate's own ">". That
    // unbalanced quote ends the scan (the `!tag` break in toolArtifactEmitters.ts), so the real
    // duplicate below is left completely untouched instead of being found or swallowed.
    const reply = `I will not repeat the <artifact tag, it won't help. ${MERMAID_ARTIFACT}`;
    expect(stripDeliveredArtifactBlocks(reply, MERMAID_ARTIFACT)).toBe(reply);
  });

  it('scans pathological input in linear time', () => {
    const started = Date.now();
    stripDeliveredArtifactBlocks('<artifact '.repeat(100_000), MERMAID_ARTIFACT);
    stripDeliveredArtifactBlocks(`${'<artifact>'.repeat(50_000)}</artifact>`, MERMAID_ARTIFACT);
    stripDeliveredArtifactBlocks(MERMAID_ARTIFACT.repeat(20_000), MERMAID_ARTIFACT);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
