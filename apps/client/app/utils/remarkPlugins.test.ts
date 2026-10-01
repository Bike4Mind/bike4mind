import { describe, it, expect } from 'vitest';
import { promoteInlineLatexDollars } from './remarkPlugins';

describe('promoteInlineLatexDollars', () => {
  describe('math spans get promoted to $$...$$', () => {
    it.each([
      ['backslash command', 'The answer is $17 \\times 24 = 408$.', 'The answer is $$17 \\times 24 = 408$$.'],
      ['caret exponent and equals', 'solve $x^2 = 9$ for x', 'solve $$x^2 = 9$$ for x'],
      ['inequality', 'true when $n > 0$ holds', 'true when $$n > 0$$ holds'],
      ['function call parens', 'evaluate $f(x)$ at zero', 'evaluate $$f(x)$$ at zero'],
      ['subscripted sequence', 'the terms $a_1, a_2$ converge', 'the terms $$a_1, a_2$$ converge'],
      ['plus and equals, no backslash', 'solve for $x + 1 = 2$', 'solve for $$x + 1 = 2$$'],
      ['bare single-letter variable', 'let $x$ be arbitrary', 'let $$x$$ be arbitrary'],
    ])('%s', (_label, input, expected) => {
      expect(promoteInlineLatexDollars(input)).toBe(expected);
    });

    it('promotes multiple LaTeX spans while leaving interleaved currency alone', () => {
      const text = 'mix $a \\times b$ and $100 and $200 more $c \\sqrt{d}$ end';
      expect(promoteInlineLatexDollars(text)).toBe('mix $$a \\times b$$ and $100 and $200 more $$c \\sqrt{d}$$ end');
    });
  });

  describe('currency and prose dollar signs are left untouched', () => {
    it.each([
      ['two amounts joined by "and"', 'the plans cost $124 and $150 per seat'],
      ['range with "to"', 'shipping runs $5 to $10'],
      ['comma/decimal amount then a bare amount', 'it was $1,000.50 or $2'],
      ['approx amounts with tildes', 'valuations ran ~$15M ... ~$40M'],
      ['single amount in prose', 'the tip costs $5'],
      ['range with "and"', 'between $3 and $4 each'],
      ['amount with a slash suffix', 'the plan is $20/month'],
      ['hyphenated amount range', 'shipping is $5-$10'],
      ['shell variable assignment', 'Set $HOME=$PWD in your shell config.'],
      ['shell path join', 'set $PATH/$SUBDIR as the search root'],
      ['braced shell variables', 'export DIR=${HOME}${SUFFIX} first'],
      ['dangling equals before whitespace', 'If $DEBUG=$ is set to any value, verbose logging turns on.'],
      ['dangling equals before a word with a space', 'Setting $DEBUG=$ true enables logging'],
      ['dangling equals before a period', 'Set $HOME=$.'],
      ['dangling equals before a comma', 'Given $HOME=$, we proceed.'],
      ['dangling slash before whitespace', 'set $PATH/$ as the base then append.'],
      ['dangling slash in a cost split', 'Cost splits as $20/$ per person, either way.'],
      ['dangling slash before a paren', 'Tickets are $50/$ (either price).'],
      ['dangling equals before a colon', 'Variable $CONFIG=$: check the docs.'],
    ])('%s', (_label, text) => {
      expect(promoteInlineLatexDollars(text)).toBe(text);
    });
  });

  it('does not touch dollars inside inline code', () => {
    const text = 'inline code: `$17 \\times 24$` should stay literal';
    expect(promoteInlineLatexDollars(text)).toBe(text);
  });

  it('does not touch dollars inside fenced code blocks', () => {
    const text = 'fenced:\n```\n$17 \\times 24$\n```\nend';
    expect(promoteInlineLatexDollars(text)).toBe(text);
  });

  it('leaves existing block math untouched', () => {
    const text = 'block math:\n$$\nL = \\frac{1}{2}\n$$\n';
    expect(promoteInlineLatexDollars(text)).toBe(text);
  });

  describe('LaTeX bracket delimiters', () => {
    it.each([
      ['inline paren', 'A \\( a^2 + b^2 \\) end', 'A $$a^2 + b^2$$ end'],
      ['inline paren, single-letter variable', 'Solve for \\(x\\):', 'Solve for $$x$$:'],
      ['mid-line bracket stays inline', 'so \\[ x^2 \\] holds', 'so $$x^2$$ holds'],
      ['own-line one-line bracket', 'D:\n\\[ g^2 + h^2 \\]\nend', 'D:\n$$\ng^2 + h^2\n$$\nend'],
      [
        'multi-line bracket block',
        'The roots are\n\\[\nx = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}\n\\]\nso done',
        'The roots are\n$$\nx = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}\n$$\nso done',
      ],
      [
        'bracket block indented in a list item',
        '1. Divide:\n   \\[\n   x^2 + \\frac{b}{a}x = 0\n   \\]\n2. Next',
        '1. Divide:\n   $$\n   x^2 + \\frac{b}{a}x = 0\n   $$\n2. Next',
      ],
      ['own-line bracket in a blockquote', '> \\[ e^{i\\pi} = -1 \\]', '> $$\n> e^{i\\pi} = -1\n> $$'],
      ['bracket content sharing the delimiter lines', '\\[ a = 1,\n   b = 2 \\]', '$$\na = 1,\n   b = 2\n$$'],
      ['two bracket spans on one line stay two inline spans', '\\[ x^2 \\] and \\[ y^2 \\]', '$$x^2$$ and $$y^2$$'],
      [
        'two bracket spans on their own line produce no fence',
        'Then\n\\[ x = 1 \\] and \\[ y = 2 \\]\ndone',
        'Then\n$$x = 1$$ and $$y = 2$$\ndone',
      ],
      ['bracket with a subscript', 'where \\[a_1\\] is', 'where $$a_1$$ is'],
      ['padded equation', 'so \\[ x = 1 \\] holds', 'so $$x = 1$$ holds'],
      ['padded sum of squares', 'so \\[ x^2 + y^2 = r^2 \\] holds', 'so $$x^2 + y^2 = r^2$$ holds'],
      ['padded subscript equation', 'so \\[ a_1 = b \\] holds', 'so $$a_1 = b$$ holds'],
      ['escaped star in an exponent', 'so \\[ x^\\* \\] holds', 'so $$x^*$$ holds'],
      ['escaped star in a product', 'so \\[ a\\*b = c \\] holds', 'so $$a*b = c$$ holds'],
      ['escaped star on its own line', '\\[ a\\*b = c \\]', '$$\na*b = c\n$$'],
      ['escaped backslash before a star is kept', 'so \\( a \\\\*b \\) holds', 'so $$a \\\\*b$$ holds'],
      ['span touching a dollar span', '$x$\\(y^2\\)', '$$x$$ $$y^2$$'],
      ['two adjacent paren spans', '\\(a^2\\)\\(b^2\\)', '$$a^2$$ $$b^2$$'],
      // Padded bodies skip the tight-only colon/word rule: turndown never pads, models do.
      ['padded subscripted name', 'so \\[ x_{max} = 5 \\] holds', 'so $$x_{max} = 5$$ holds'],
      ['padded word-named variables', 'so \\[ v_{avg} = d / t \\] holds', 'so $$v_{avg} = d / t$$ holds'],
      ['padded bare sum', 'so \\[ sum_{i=1}^n i \\] holds', 'so $$sum_{i=1}^n i$$ holds'],
      ['padded bare function names', 'so \\[ f(x) = max(0, x) \\] holds', 'so $$f(x) = max(0, x)$$ holds'],
      ['own-line padded word equation', '\\[ area = pi r^2 \\]', '$$\narea = pi r^2\n$$'],
      ['own-line padded ratio with colons', '\\[ a:b = c:d \\]', '$$\na:b = c:d\n$$'],
      ['own-line block closing after an escaped backslash', '\\[ a = b \\\\ \\]', '$$\na = b \\\\\n$$'],
    ])('%s', (_label, input, expected) => {
      expect(promoteInlineLatexDollars(input)).toBe(expected);
    });

    it.each([
      ['paren inside inline code', 'use `\\(x^2\\)` literally'],
      ['bracket inside a fence', '```\n\\[x^2\\]\n```'],
      ['LaTeX line break with spacing', 'a \\\\[2pt] b \\\\]'],
      ['escaped backslash before paren', 'path \\\\(x^2\\\\) here'],
      ['markdown-escaped citation', 'see \\[1\\] and \\[2\\]'],
      ['markdown-escaped citation on its own line', '\\[1\\]'],
      ['escaped parens around prose', 'he said \\(sic\\) twice'],
      ['bracket content holding a dollar', 'cost \\[ x = $5^2 \\]'],
      ['unclosed bracket does not cross a blank line', '\\[ x^2\n\nlater \\]'],
      // turndown output: Knowledge files store scraped and emailed HTML with brackets escaped.
      ['escaped author-year citation', 'As shown in \\[Smith (2020)\\], x'],
      ['escaped letter footnote link', '1850.[\\[a\\]](#cite-a)'],
      ['escaped task-list checkbox', '-   \\[x\\] Ship'],
      ['escaped array indexes', 'arr\\[i\\] and m\\[j\\]\\[k\\]'],
      ['escaped bracket around an escaped underscore', 'Use \\[foo\\_bar\\]'],
      ['escaped single letter on its own line', '\\[a\\]'],
      ['own-line escaped brackets with prose between', '\\[a\\] see note (1)\n\\[b\\]'],
      ['blockquote block with a lazy-continuation line', '> \\[\nx^2\n> \\]\nafter'],
      ['escaped sample size', 'Results \\[n = 30\\] were'],
      ['escaped note with a colon on its own line', '\\[Note: n = 30 participants\\]'],
      ['escaped exponent', '\\[2^n\\] ways'],
      ['escaped update with a colon', '\\[Update: x = 5\\]'],
      ['escaped equality with no padding', 'See \\[a=b\\] here'],
      ['escaped star with no math evidence', 'Use \\[foo\\*\\]'],
      ['padded prose with no math evidence', 'See \\[ see note \\] here'],
      ['own-line padded prose with no math evidence', '\\[ see note \\]'],
      ['own-line bracket whose closer is an escaped backslash', '\\[ a = b \\\\]'],
    ])('leaves %s alone', (_label, text) => {
      expect(promoteInlineLatexDollars(text)).toBe(text);
    });

    it('stays linear on a long backslash run after an own-line opener', () => {
      // A per-character lookbehind in the block body took ~1s on 80k backslashes; linear is ~1ms.
      const text = '\\[ ' + '\\'.repeat(100_000);
      const start = performance.now();
      expect(promoteInlineLatexDollars(text)).toBe(text);
      expect(performance.now() - start).toBeLessThan(500);
    });

    it('treats a bracket right after inline code as mid-line', () => {
      expect(promoteInlineLatexDollars('`f` \\[ x^2 \\] `g`')).toBe('`f` $$x^2$$ `g`');
    });

    it('does not re-promote its own $$ output as a single-dollar span', () => {
      const out = promoteInlineLatexDollars('\\(a\\) and \\(b^2\\) cost $5');
      expect(out).toBe('$$a$$ and $$b^2$$ cost $5');
      expect(out).not.toContain('$$$');
    });
  });
});
