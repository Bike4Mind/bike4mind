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
});
