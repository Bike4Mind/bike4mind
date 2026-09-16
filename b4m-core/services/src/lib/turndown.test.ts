import { describe, it, expect } from 'vitest';
import { cleanEmailHtml } from './turndown';

describe('cleanEmailHtml', () => {
  it('still removes the noise it is there to remove', () => {
    const html = [
      '<style>a{color:red}</style>',
      '<script>track()</script>',
      '<p>Real body</p>',
      '<img width="1" height="1" src="https://t.example/o.gif">',
      '<img alt="__tpx__" src="z">',
      '<div class="gmail_signature">Sent from my phone</div>',
      '<a href="https://x.example/unsubscribe?u=1">Unsubscribe</a>',
      '<div class="mailing-list">footer</div>',
      '<!-- email signature -->Jane Doe<!-- /email signature -->',
    ].join('');
    expect(cleanEmailHtml(html)).toBe('<p>Real body</p>');
  });

  // The two shapes a regex could not cover at once. Stopping the gap spans at any table
  // boundary stopped the cleaner swallowing an enclosing layout table, but also stopped
  // it firing on the standard Outlook/WiseStamp signature, where a name/title table
  // closes BEFORE the icon row. Tracking nesting gets both.
  it('removes the social table the link is actually in, not the layout table around it', () => {
    const html =
      '<table class="layout"><tr><td>' +
      '<table><tr><td><a href="https://linkedin.com/in/x">li</a></td></tr></table>' +
      '</td></tr></table>';
    expect(cleanEmailHtml(html)).toBe('<table class="layout"><tr><td></td></tr></table>');
  });

  it('removes a signature table whose nested name block closes before the icon row', () => {
    const html =
      '<table class="sig"><tr><td><table><tr><td>Jane, CEO</td></tr></table></td></tr>' +
      '<tr><td><a href="https://linkedin.com/in/x"><img src="li.png"></a></td></tr></table>';
    expect(cleanEmailHtml(html)).toBe('');
  });

  it('removes a flat social icon table', () => {
    const html = '<p>hi</p><table><tr><td><a href="https://twitter.com/x">t</a></td></tr></table><p>bye</p>';
    expect(cleanEmailHtml(html)).toBe('<p>hi</p><p>bye</p>');
  });

  // Each case below exceeds a length bound the previous implementation imposed, so each
  // one silently stopped being cleaned. There is no bound now; they must clean again.
  it('removes a signature div carrying an inline base64 logo', () => {
    const html = '<p>body</p><div class="signature"><img src="data:image/png;base64,' + 'A'.repeat(25_000) + '"></div>';
    expect(cleanEmailHtml(html)).toBe('<p>body</p>');
  });

  it('removes a 1x1 tracking pixel behind a long encoded tracking URL', () => {
    const html = '<p>body</p><img width="1" height="1" src="https://mkto.example/t?q=' + 'X'.repeat(1_200) + '">';
    expect(cleanEmailHtml(html)).toBe('<p>body</p>');
  });

  it('removes a style block larger than the old element-body bound', () => {
    const html = '<style>' + '.a{color:red}'.repeat(3_000) + '</style><p>body</p>';
    expect(cleanEmailHtml(html)).toBe('<p>body</p>');
  });

  it('cleans the whole document, not a capped prefix', () => {
    const html = '<p>head</p>' + '<p>filler</p>'.repeat(20_000) + '<script>late()</script>';
    const out = cleanEmailHtml(html);
    expect(out).not.toContain('late()');
    expect(out.startsWith('<p>head</p>')).toBe(true);
  });

  it('does not end a tag on a ">" inside a quoted attribute value', () => {
    const html = '<p title="a > b">body</p><img alt="__tpx__" src="z">';
    expect(cleanEmailHtml(html)).toBe('<p title="a > b">body</p>');
  });

  it('takes script/style bodies as raw text so a "<" in them is not read as markup', () => {
    const html = '<script>if (a < b) { drop(); }</script><p>body</p>';
    expect(cleanEmailHtml(html)).toBe('<p>body</p>');
  });

  it('leaves unmatched markup alone rather than splicing to the wrong close tag', () => {
    const html = '<div class="signature">never closed<p>body</p>';
    expect(cleanEmailHtml(html)).toBe(html);
  });

  // Behaviour lock. These are the well-formed shapes real mail is made of; the cleaners
  // are a heuristic, so the point is that the exact output is pinned and a future edit
  // has to state the change rather than drift into it.
  it.each([
    ['plain paragraph', '<p>Hello there</p>', '<p>Hello there</p>'],
    [
      'heading and link',
      '<h1>Hi</h1><a href="https://example.com">site</a>',
      '<h1>Hi</h1><a href="https://example.com">site</a>',
    ],
    ['layout table kept', '<table><tr><td>Q1 revenue</td></tr></table>', '<table><tr><td>Q1 revenue</td></tr></table>'],
    [
      'non-1x1 image kept',
      '<img width="600" src="https://cdn.example/hero.png">',
      '<img width="600" src="https://cdn.example/hero.png">',
    ],
    ['single-quoted signature class', "<div class='my-signature'>x</div><p>b</p>", '<p>b</p>'],
    ['uppercase tags', '<STYLE>a{}</STYLE><P>body</P>', '<P>body</P>'],
    ['nested divs inside a signature', '<div class="signature"><div>inner</div></div><p>b</p>', '<p>b</p>'],
    ['unsubscribe anchor only', '<p>a</p><a href="/unsubscribe">Opt out</a><p>b</p>', '<p>a</p><p>b</p>'],
  ])('behaviour lock: %s', (_label, input, expected) => {
    expect(cleanEmailHtml(input)).toBe(expected);
  });

  // Every shape below made the previous implementation super-linear: an unterminated tag
  // restarted a whole-document scan at every `<tag` position. The pass is a single linear
  // tokenizer now, so 512k of the worst shape is milliseconds, not seconds. The budget is
  // tight on purpose - at 5s a 20x regression would still pass.
  it.each([
    ['unterminated quoted attribute', '<div class="signature'],
    ['unterminated img tag', '<img src="x" '],
    ['unterminated style tag', '<style>'],
    ['unterminated script tag', '<script>'],
    ['unterminated unsubscribe anchor', '<a href="unsubscribe">'],
    ['unclosed social icon tables', '<table><a href="https://www.linkedin.com/in/x">hi</a>'],
    ['open signature divs', '<div class="signature">x'],
    ['nested table soup', '<table><tr><td>'],
  ])('stays linear on 512k of an adversarial body: %s', (_label, unit) => {
    const html = unit.repeat(Math.ceil(524_288 / unit.length));
    const started = Date.now();
    expect(typeof cleanEmailHtml(html)).toBe('string');
    expect(Date.now() - started).toBeLessThan(250);
  });
});
