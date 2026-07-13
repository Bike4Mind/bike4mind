import { describe, it, expect } from 'vitest';
import { promoteInlineLatexDollars } from './remarkPlugins';

describe('promoteInlineLatexDollars', () => {
  it('promotes an inline LaTeX span containing a backslash command', () => {
    expect(promoteInlineLatexDollars('The answer is $17 \\times 24 = 408$.')).toBe(
      'The answer is $$17 \\times 24 = 408$$.'
    );
  });

  it('leaves currency prose with two dollar amounts untouched', () => {
    const text = 'the plans cost $124 and $150 per seat';
    expect(promoteInlineLatexDollars(text)).toBe(text);
  });

  it('leaves LaTeX without a backslash command untouched', () => {
    const text = 'solve for $x + 1 = 2$';
    expect(promoteInlineLatexDollars(text)).toBe(text);
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

  it('promotes multiple LaTeX spans while leaving interleaved currency alone', () => {
    const text = 'mix $a \\times b$ and $100 and $200 more $c \\sqrt{d}$ end';
    expect(promoteInlineLatexDollars(text)).toBe('mix $$a \\times b$$ and $100 and $200 more $$c \\sqrt{d}$$ end');
  });
});
