import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { promoteInlineLatexDollars, remarkGfmNoSingleTilde } from './remarkPlugins';

// Asserts on rendered KaTeX, not the preprocessed string, because the failure mode is the parser
// eating `\(`/`\[` as escapes. Plugin sets mirror PromptReplies (gfm) and UserPrompt (breaks).
const PLUGIN_SETS = {
  'assistant reply (gfm)': [remarkGfmNoSingleTilde, [remarkMath, { singleDollarTextMath: false }]],
  'user bubble (breaks)': [remarkBreaks, [remarkMath, { singleDollarTextMath: false }]],
} as const;

function render(markdown: string, remarkPlugins: (typeof PLUGIN_SETS)[keyof typeof PLUGIN_SETS]) {
  const html = renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={[...remarkPlugins]} rehypePlugins={[rehypeKatex]}>
      {promoteInlineLatexDollars(markdown)}
    </ReactMarkdown>
  );
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out = {
    katex: doc.querySelectorAll('.katex').length,
    errors: doc.querySelectorAll('.katex-error').length,
    displayText: Array.from(doc.querySelectorAll('.katex-display')).map(el => el.textContent ?? ''),
    // KaTeX's TeX source per node, from the MathML annotation.
    tex: Array.from(doc.querySelectorAll('.katex annotation')).map(el => el.textContent ?? ''),
    listItems: doc.querySelectorAll('li').length,
    linkText: Array.from(doc.querySelectorAll('a')).map(el => el.textContent ?? ''),
    text: '',
  };
  // Visible text with KaTeX's MathML/annotation copy removed, so raw leftovers stand out.
  doc.querySelectorAll('.katex, .katex-error').forEach(el => el.remove());
  out.text = doc.body.textContent ?? '';
  return out;
}

const ECHO_PROMPT = [
  'A: inline paren \\( a^2 + b^2 \\) end',
  'B: inline dollar $c^2 + d^2$ end',
  'C: display double dollar $$e^2 + f^2$$',
  'D: display bracket',
  '\\[ g^2 + h^2 \\]',
].join('\n');

const QUADRATIC = [
  'Solve for \\( x \\):',
  '',
  '1. Divide by \\( a \\):',
  '   \\[',
  '   x^2 + \\frac{b}{a}x + \\frac{c}{a} = 0',
  '   \\]',
  '2. Complete the square:',
  '   \\[',
  '   x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}',
  '   \\]',
].join('\n');

describe.each(Object.entries(PLUGIN_SETS))('LaTeX delimiters render as KaTeX: %s', (_label, plugins) => {
  it('renders all four delimiter styles from the echo prompt', () => {
    const out = render(ECHO_PROMPT, plugins);
    expect(out.katex).toBe(4);
    expect(out.displayText).toHaveLength(1);
    expect(out.displayText[0]).toMatch(/g2\+h2/);
    expect(out.text).not.toMatch(/a\^2|g\^2/);
    expect(out.text).toContain('inline paren');
    expect(out.text).toContain('end');
  });

  it('renders a bracket block inside a numbered list as display math without breaking the list', () => {
    const out = render(QUADRATIC, plugins);
    expect(out.katex).toBe(4);
    expect(out.displayText).toHaveLength(2);
    expect(out.displayText[0]).toMatch(/frac|ca/);
    expect(out.displayText[1]).toMatch(/sqrt|\u221A/);
    expect(out.listItems).toBe(2);
    expect(out.text).not.toMatch(/\\frac|x\^2/);
  });

  it.each([
    ['on one line', '\\[ x^2 \\] and \\[ y^2 \\]', ['x^2', 'y^2'], ['and']],
    ['on their own line', 'Then\n\\[ x = 1 \\] and \\[ y = 2 \\]\ndone', ['x = 1', 'y = 2'], ['Then', 'and', 'done']],
  ])('renders two bracket spans %s as two inline nodes, not a KaTeX error', (_label, markdown, tex, prose) => {
    const out = render(markdown, plugins);
    expect(out.errors).toBe(0);
    expect(out.katex).toBe(2);
    expect(out.tex).toEqual(tex);
    expect(out.displayText).toHaveLength(0);
    for (const word of prose) expect(out.text).toContain(word);
  });

  it.each([
    ['inline', 'so \\[ a\\*b = c \\] holds'],
    ['display', '\\[ x^\\* \\]'],
  ])('renders a bracket span with an escaped star (%s) as math, not a KaTeX error', (_label, markdown) => {
    const out = render(markdown, plugins);
    expect(out.errors).toBe(0);
    expect(out.katex).toBe(1);
    expect(out.text).not.toContain('\\');
  });

  it('renders a dollar span touching a paren span as two nodes with no raw dollars', () => {
    const out = render('$x$\\(y^2\\)', plugins);
    expect(out.errors).toBe(0);
    expect(out.tex).toEqual(['x', 'y^2']);
    expect(out.text).not.toContain('$');
  });

  it('keeps markdown-escaped brackets in a footnote link as literal text', () => {
    const out = render('Founded in 1850.[\\[a\\]](#cite-a) As shown in \\[Smith (2020)\\].', plugins);
    expect(out.katex).toBe(0);
    expect(out.linkText).toEqual(['[a]']);
    expect(out.text).toContain('[Smith (2020)]');
  });

  it('keeps the paragraph after an under-indented list math body out of the math', () => {
    const markdown = '- item\n  \\[ a = b\nc^2 \\]\n\nNext paragraph.';
    const html = renderToStaticMarkup(
      <ReactMarkdown remarkPlugins={[...plugins]} rehypePlugins={[rehypeKatex]}>
        {promoteInlineLatexDollars(markdown)}
      </ReactMarkdown>
    );
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const para = Array.from(doc.querySelectorAll('p')).find(el => el.textContent?.includes('Next paragraph.'));
    expect(para).toBeDefined();
    expect(para!.closest('.katex')).toBeNull();
  });
});
