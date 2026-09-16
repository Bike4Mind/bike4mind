import { describe, it, expect } from 'vitest';
import { cleanEmailHtml } from './turndown';

/**
 * Differential corpus against the implementation this replaced.
 *
 * cleanEmailHtml used to be eleven independent regex passes. They were replaced by a
 * single linear tokenizer, and the argument for that rewrite was that it is equivalent on
 * real email and better on the shapes the regexes got wrong. `legacyCleanEmailHtml` below
 * is that previous implementation, verbatim, so the claim is executable rather than
 * asserted - and so a future edit that drifts from it has to say so here.
 *
 * The regexes are unbounded, which is what made them quadratic to cubic; every input in
 * this file is small, so they terminate.
 */
const legacyCleanEmailHtml = (html: string): string => {
  let cleaned = html;
  cleaned = cleaned.replace(/<img[^>]*src="https:\/\/tracy\.srv\.wisestamp\.com[^"]*"[^>]*>/gi, '');
  cleaned = cleaned.replace(/<img[^>]*alt="__tpx__"[^>]*>/gi, '');
  cleaned = cleaned.replace(/<img[^>]*(?:width|height)=["']1["'][^>]*>/gi, '');
  cleaned = cleaned.replace(/<!--\s*email signature\s*-->[\s\S]*?<!--\s*\/email signature\s*-->/gim, '');
  cleaned = cleaned.replace(/<div[^>]*class=["'][^"']*signature[^"']*["'][^>]*>[\s\S]*?<\/div>/gim, '');
  cleaned = cleaned.replace(/<div[^>]*gmail_signature[^>]*>[\s\S]*?<\/div>/gim, '');
  cleaned = cleaned.replace(/<a[^>]*href=["'][^"']*unsubscribe[^"']*["'][^>]*>.*?<\/a>/gi, '');
  cleaned = cleaned.replace(/<div[^>]*class=["'][^"']*mailing-list[^"']*["'][^>]*>[\s\S]*?<\/div>/gim, '');
  cleaned = cleaned.replace(/List-Unsubscribe:.*$/gim, '');
  cleaned = cleaned.replace(
    /<table[^>]*>[\s\S]*?<a[^>]*(?:linkedin|twitter|facebook|instagram)[^>]*>[\s\S]*?<\/table>/gim,
    ''
  );
  cleaned = cleaned.replace(/<style[^>]*>[\s\S]*?<\/style>/gim, '');
  cleaned = cleaned.replace(/<script[^>]*>[\s\S]*?<\/script>/gim, '');
  return cleaned;
};

// Well-formed shapes real mail is made of. The two implementations must agree on all of
// them - this is the corpus the rewrite rests on.
const AGREES: Array<[string, string]> = [
  ['plain paragraph', '<p>Hello there</p>'],
  ['heading and link', '<h1>Hi</h1><a href="https://example.com">site</a>'],
  ['layout table kept', '<table><tr><td>Q1 revenue</td></tr></table>'],
  ['nested layout tables kept', '<table><tr><td><table><tr><td>cell</td></tr></table></td></tr></table>'],
  ['non-1x1 image kept', '<img width="600" src="https://cdn.example/hero.png">'],
  ['1x1 tracking pixel', '<p>a</p><img width="1" height="1" src="https://t.example/o.gif"><p>b</p>'],
  ['wisestamp pixel', '<p>a</p><img src="https://tracy.srv.wisestamp.com/x.gif" width="2"><p>b</p>'],
  ['tpx pixel', '<p>a</p><img alt="__tpx__" src="z"><p>b</p>'],
  ['style block', '<style>a{color:red}</style><p>body</p>'],
  ['script block', '<script>track()</script><p>body</p>'],
  ['gmail signature', '<p>a</p><div class="gmail_signature">Sent from my phone</div><p>b</p>'],
  ['signature class div', '<p>a</p><div class="signature">Jane</div><p>b</p>'],
  ['single-quoted signature class', "<p>a</p><div class='my-signature'>Jane</div><p>b</p>"],
  ['mailing-list footer', '<p>a</p><div class="mailing-list">footer</div><p>b</p>'],
  ['unsubscribe anchor', '<p>a</p><a href="https://x.example/unsubscribe?u=1">Unsubscribe</a><p>b</p>'],
  ['List-Unsubscribe header line', 'List-Unsubscribe: <https://x.example/u>\n<p>body</p>'],
  ['comment-delimited signature', '<p>a</p><!-- email signature -->Jane<!-- /email signature --><p>b</p>'],
  [
    'flat social icon table',
    '<p>hi</p><table><tr><td><a href="https://twitter.com/x">t</a></td></tr></table><p>bye</p>',
  ],
  ['uppercase tags', '<STYLE>a{}</STYLE><P>body</P>'],
  ['marketing row', '<div class="row"><p>Hello</p><img src="https://cdn.example/a.png" width="600"></div>'],
  ['empty document', ''],
  ['text only', 'Just a plain sentence with no markup at all.'],
  // Both implementations get these right, by different means: the regexes because their
  // character classes happen to cover them, the tokenizer because it tracks quoting and
  // treats script/style as raw text. Kept so the tokenizer cannot regress on them.
  ['">" inside a quoted attribute value', '<p title="a > b">body</p><img alt="__tpx__" src="z">'],
  ['"<" inside a script body', '<script>if (a < b) { drop(); }</script><p>body</p>'],
  // The standard Outlook/WiseStamp signature: a name/title table closes BEFORE the icon
  // row. This is the shape the bounded regexes shipped earlier in this PR stopped
  // removing; the tokenizer restores it.
  [
    'signature table whose name block closes before the icon row',
    '<table class="sig"><tr><td><table><tr><td>Jane, CEO</td></tr></table></td></tr><tr><td><a href="https://linkedin.com/in/x">li</a></td></tr></table>',
  ],
];

// Shapes where the two DISAGREE, deliberately. Each one is a defect in the regex pass that
// the rewrite exists to fix; the expected value is the new, correct output.
const DIVERGES: Array<[string, string, string, string]> = [
  [
    'social link nested inside a layout table',
    "the regex ran to the INNER </table>, orphaning the outer table's closing tags",
    '<table class="layout"><tr><td><table><tr><td><a href="https://linkedin.com/in/x">li</a></td></tr></table></td></tr></table>',
    '<table class="layout"><tr><td></td></tr></table>',
  ],
  [
    'signature div containing a nested div',
    'the regex stopped at the FIRST </div>, leaving the signature half-removed',
    '<p>a</p><div class="signature"><div>inner</div></div><p>b</p>',
    '<p>a</p><p>b</p>',
  ],
];

describe('cleanEmailHtml differential corpus', () => {
  it.each(AGREES)('agrees with the previous implementation: %s', (_label, input) => {
    expect(cleanEmailHtml(input)).toBe(legacyCleanEmailHtml(input));
  });

  it.each(DIVERGES)('diverges deliberately: %s (%s)', (_label, _why, input, expected) => {
    expect(cleanEmailHtml(input)).toBe(expected);
    expect(legacyCleanEmailHtml(input)).not.toBe(expected);
  });
});
