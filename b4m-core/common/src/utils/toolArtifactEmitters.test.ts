import { describe, it, expect } from 'vitest';
import { stripToolArtifactMarkup, stripDeliveredArtifactBlocks } from './toolArtifactEmitters';

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
