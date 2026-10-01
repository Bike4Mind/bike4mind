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
  return {
    katex: doc.querySelectorAll('.katex').length,
    display: doc.querySelectorAll('.katex-display').length,
    listItems: doc.querySelectorAll('li').length,
    // Visible text with KaTeX's MathML/annotation copy removed, so raw leftovers stand out.
    text: Array.from(doc.querySelectorAll('.katex')).reduce(
      (acc, el) => acc.replace(el.textContent ?? '', ''),
      doc.body.textContent ?? ''
    ),
  };
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
    expect(out.display).toBe(1);
    expect(out.text).not.toMatch(/a\^2|g\^2/);
  });

  it('renders a bracket block inside a numbered list as display math without breaking the list', () => {
    const out = render(QUADRATIC, plugins);
    expect(out.katex).toBe(4);
    expect(out.display).toBe(2);
    expect(out.listItems).toBe(2);
    expect(out.text).not.toMatch(/\\frac|x\^2/);
  });
});
