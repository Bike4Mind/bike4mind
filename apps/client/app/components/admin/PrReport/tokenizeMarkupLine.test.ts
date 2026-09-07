import { describe, it, expect } from 'vitest';

import { tokenizeMarkupLine } from './tokenizeMarkupLine';

const NAMES = { U0WESCARD: 'Wes Carda', S0REVIEWERS: 'Reviewers' };

describe('tokenizeMarkupLine - the constructs the renderer emits', () => {
  it('resolves a mention to a display name', () => {
    expect(tokenizeMarkupLine('owed by <@U0WESCARD>', NAMES)).toEqual([
      { kind: 'text', text: 'owed by ' },
      { kind: 'mention', name: 'Wes Carda' },
    ]);
  });

  it('falls back to the raw member id when the name is unknown', () => {
    // The degraded-but-honest preview: better a raw id than an invented name.
    expect(tokenizeMarkupLine('<@U0UNKNOWN>', {})).toEqual([{ kind: 'mention', name: 'U0UNKNOWN' }]);
  });

  it('splits a link into url and label', () => {
    expect(tokenizeMarkupLine('<https://github.com/x/y/pull/1|#1 Title>', NAMES)).toEqual([
      { kind: 'link', url: 'https://github.com/x/y/pull/1', label: '#1 Title' },
    ]);
  });

  it('resolves a user-group (subteam) mention', () => {
    // The subteam form is how a group actually gets pinged; the preview must show it as
    // a mention, not leave the raw `<!subteam^...>` markup on screen.
    expect(tokenizeMarkupLine('review pool <!subteam^S0REVIEWERS>', NAMES)).toEqual([
      { kind: 'text', text: 'review pool ' },
      { kind: 'mention', name: 'Reviewers' },
    ]);
  });

  it('falls back to the raw group id when the name is unknown', () => {
    expect(tokenizeMarkupLine('<!subteam^S0UNKNOWN>', {})).toEqual([{ kind: 'mention', name: 'S0UNKNOWN' }]);
  });

  it('does not treat a bare <@S...> group id as a notifying mention', () => {
    // Slack renders <@S...> as inert text, so the preview must not imply it pings.
    const tokens = tokenizeMarkupLine('<@S0REVIEWERS>', NAMES);
    expect(tokens.every(token => token.kind === 'text')).toBe(true);
  });

  it('renders a non-http(s) link target as inert text, never a clickable link', () => {
    // Defense-in-depth against admin-pasted `javascript:` (self-XSS on the admin route).
    expect(tokenizeMarkupLine('<javascript:alert(1)|Merge me>', NAMES)).toEqual([{ kind: 'text', text: 'Merge me' }]);
  });

  it('reads bold and italic', () => {
    expect(tokenizeMarkupLine('*Awaiting review*', NAMES)).toEqual([{ kind: 'bold', text: 'Awaiting review' }]);
    expect(tokenizeMarkupLine('_standard_', NAMES)).toEqual([{ kind: 'italic', text: 'standard' }]);
  });

  it('handles a full digest line', () => {
    const tokens = tokenizeMarkupLine('• <https://x.test/1|#1 Fix thing> - <@U0WESCARD>', NAMES);

    expect(tokens.map(token => token.kind)).toEqual(['text', 'link', 'text', 'mention']);
  });
});

describe('tokenizeMarkupLine - emphasis boundaries', () => {
  it('does NOT toggle italics inside an identifier', () => {
    // `qa_passed` and `qa_failed` on one line would otherwise italicize everything
    // between the two underscores and swallow half the line.
    const tokens = tokenizeMarkupLine('handle qa_passed and qa_failed', NAMES);

    expect(tokens).toEqual([{ kind: 'text', text: 'handle qa_passed and qa_failed' }]);
  });

  it('does NOT toggle bold across separated asterisks', () => {
    const tokens = tokenizeMarkupLine('a * b * c', NAMES);
    expect(tokens.every(token => token.kind === 'text')).toBe(true);
  });

  it('recognizes emphasis at a punctuation boundary', () => {
    expect(tokenizeMarkupLine('(*bold*)', NAMES)).toEqual([
      { kind: 'text', text: '(' },
      { kind: 'bold', text: 'bold' },
      { kind: 'text', text: ')' },
    ]);
  });
});

describe('tokenizeMarkupLine - escaping round-trip', () => {
  it('decodes the entities the renderer escapes', () => {
    expect(tokenizeMarkupLine('fix &lt;script&gt; &amp; more', NAMES)).toEqual([
      { kind: 'text', text: 'fix <script> & more' },
    ]);
  });

  it('does not decode twice - a literal &lt; in a title survives as text', () => {
    // `&amp;lt;` is what the renderer produces for a title containing the literal
    // characters `&lt;`. Decoding `&amp;` last is what keeps it from becoming `<`.
    expect(tokenizeMarkupLine('&amp;lt;', NAMES)).toEqual([{ kind: 'text', text: '&lt;' }]);
  });

  it('does not treat an escaped mention as a real one', () => {
    const tokens = tokenizeMarkupLine('title &lt;@U0EVIL999&gt; here', NAMES);

    expect(tokens.every(token => token.kind === 'text')).toBe(true);
    expect(tokens[0].kind === 'text' && tokens[0].text).toContain('<@U0EVIL999>');
  });

  it('returns an empty token list for an empty line', () => {
    expect(tokenizeMarkupLine('', NAMES)).toEqual([]);
  });
});
