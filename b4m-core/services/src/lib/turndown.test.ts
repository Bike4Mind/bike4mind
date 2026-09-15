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
    ].join('');
    expect(cleanEmailHtml(html)).toBe('<p>Real body</p>');
  });

  it('removes a social icon table without swallowing the layout table around it', () => {
    // The previous pattern let the gap spans cross table boundaries, so an enclosing
    // layout table was consumed up to the INNER `</table>`, leaving orphaned closing
    // tags behind. The gaps now stop at any table boundary, so the nested social table
    // is matched on its own - which is the element actually being removed.
    const html =
      '<table class="layout"><tr><td>' +
      '<table><tr><td><a href="https://linkedin.com/in/x">li</a></td></tr></table>' +
      '</td></tr></table>';
    const out = cleanEmailHtml(html);
    expect(out).toBe('<table class="layout"><tr><td></td></tr></table>');
    expect(out).not.toContain('linkedin');
  });

  it('removes a flat social icon table', () => {
    const html = '<p>hi</p><table><tr><td><a href="https://twitter.com/x">t</a></td></tr></table><p>bye</p>';
    expect(cleanEmailHtml(html)).toBe('<p>hi</p><p>bye</p>');
  });

  it('passes the tail of an over-cap body through instead of dropping it', () => {
    // The cap bounds what is scanned, not what is returned: truncating the value would
    // silently lose the tail of an ingested email, and a cut landing inside a
    // <style>/<script> would strand its closing tag and leak its contents through.
    const tail = '<p>TAIL_MARKER</p>';
    const html = '<p>head</p>' + 'y'.repeat(40_000) + tail;
    const out = cleanEmailHtml(html);
    expect(out).toContain('TAIL_MARKER');
    expect(out).toHaveLength(html.length);
  });

  it('does not split a surrogate pair across the cap boundary', () => {
    const html = '<p>' + 'z'.repeat(31_999) + '\u{1F600}</p>';
    const out = cleanEmailHtml(html);
    expect(out).toBe(html);
    expect([...out].includes('\u{1F600}')).toBe(true);
  });

  // Each adversarial shape below made the unbounded cleaners super-linear: an
  // unterminated tag restarted a whole-document scan at every `<tag` position. They
  // are bounded now, so these complete in well under the vitest timeout - a regression
  // fails the suite by timing out rather than hanging CI forever.
  it.each([
    ['unterminated quoted attribute', '<div class="signature'],
    ['unterminated img tag', '<img src="x" '],
    ['unterminated style tag', '<style>'],
    ['unterminated script tag', '<script>'],
    ['unterminated unsubscribe anchor', '<a href="unsubscribe">'],
    ['unclosed social icon tables', '<table><a href="https://www.linkedin.com/in/x">hi</a>'],
  ])('completes on an adversarial body: %s', (_label, unit) => {
    const html = unit.repeat(Math.ceil(200_000 / unit.length));
    const started = Date.now();
    const out = cleanEmailHtml(html);
    expect(typeof out).toBe('string');
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
