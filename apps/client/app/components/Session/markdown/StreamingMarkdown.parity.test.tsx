import React, { useEffect, type ComponentProps } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import ReactMarkdown, { type Components, type ExtraProps, type Options } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import { assistantReplyRemarkPlugins, promoteInlineLatexDollars } from '@client/app/utils/remarkPlugins';
import { StreamingMarkdown } from './StreamingMarkdown';
import { ReplyMarkdownImage } from '../ReplyMarkdownImage';

vi.mock('../ImageContainer', () => ({
  default: ({ src }: { src: string }) => <img data-testid="reply-image-loaded" src={src} alt="" />,
}));

const remarkPlugins: Options['remarkPlugins'] = [...assistantReplyRemarkPlugins];
const rehypePlugins: Options['rehypePlugins'] = [rehypeKatex];
const remarkRehypeOptions: Options['remarkRehypeOptions'] = { clobberPrefix: 'fn-q1-' };
const baseComponents: Components = {};

const CORPUS: Record<string, string> = {
  referenceAndFootnote:
    'See [the docs][d] and a claim[^1].\n\nMore prose.\n\n[d]: https://example.com\n[^1]: Source text.',
  setext: 'Title\n=====\n\nSub\n---\n\nbody',
  tableNoBlankBefore: 'intro\n| a | b |\n|---|---|\n| 1 | 2 |\n\nafter',
  looseList: '1. alpha\n\n2. beta\n\n3. gamma',
  nestedFence: '````md\n```js\nx\n```\n\nstill md\n````\n\nafter',
  tildeFence: '~~~py\nx = 1\n\ny = 2\n~~~\n\ndone',
  listFence: '- step\n\n  ```sh\n  a\n\n  b\n  ```\n\n- next',
  mathBlock: 'intro\n\n$$\na = b\n\nc = d\n$$\n\nafter',
  inlineMath: promoteInlineLatexDollars('Energy $E = mc^2$ costs $5 to $10.\n\nNext para $x^2$.'),
  crlf: 'para one\r\n\r\npara two\r\n\r\n- a\r\n- b',
  whitespaceBlank: 'para one\n   \npara two\n\n\n\npara three   \n\n',
  details: '<details>\n<summary>S</summary>\n\nbody **bold**\n\n</details>\n\nafter',
  fenceInfoInside: '```markdown\nExample:\n```js\nconsole.log(1)\n\nconsole.log(2)\n```\n\nafter',
  headings: '# Same\n\ntext\n\n# Same\n\nmore',
};

const Plain = ({ text }: { text: string }) => (
  <ReactMarkdown
    components={baseComponents}
    remarkPlugins={remarkPlugins}
    rehypePlugins={rehypePlugins}
    remarkRehypeOptions={remarkRehypeOptions}
  >
    {text}
  </ReactMarkdown>
);

const Subject = ({
  text,
  streaming,
  components = baseComponents,
}: {
  text: string;
  streaming: boolean;
  components?: Components;
}) => (
  <StreamingMarkdown
    text={text}
    streaming={streaming}
    components={components}
    remarkPlugins={remarkPlugins}
    rehypePlugins={rehypePlugins}
    remarkRehypeOptions={remarkRehypeOptions}
  />
);

const baseHtml = (text: string) => render(<Plain text={text} />).container.innerHTML;

const chunks = (text: string, size: number) => {
  const out: string[] = [];
  for (let i = size; i < text.length; i += size) out.push(text.slice(0, i));
  out.push(text);
  return out;
};

describe('StreamingMarkdown final render equals the base single ReactMarkdown', () => {
  for (const [name, text] of Object.entries(CORPUS)) {
    it(`${name}: streamed chunk by chunk then completed`, () => {
      const expected = baseHtml(text);
      const { container, rerender } = render(<Subject text="" streaming />);
      for (const prefix of chunks(text, 3)) rerender(<Subject text={prefix} streaming />);
      rerender(<Subject text={text} streaming={false} />);
      // React leaves an empty style attribute behind when a KaTeX error span's style goes away.
      expect(container.innerHTML.replace(/ style=""/g, '')).toBe(expected);
    });
  }

  it('a reply that is not streaming from the first render matches the base render', () => {
    for (const text of Object.values(CORPUS)) {
      const { container, unmount } = render(<Subject text={text} streaming={false} />);
      expect(container.innerHTML).toBe(baseHtml(text));
      unmount();
    }
  });
});

describe('StreamingMarkdown memoisation', () => {
  it('re-renders the committed half when the components map changes', () => {
    const text = 'alpha para\n\nbeta tail';
    const a: Components = { p: ({ children }: ComponentProps<'p'>) => <p data-v="a">{children}</p> };
    const b: Components = { p: ({ children }: ComponentProps<'p'>) => <p data-v="b">{children}</p> };
    const { container, rerender } = render(<Subject text={text} streaming components={a} />);
    rerender(<Subject text={text} streaming components={b} />);
    const marks = Array.from(container.querySelectorAll('p')).map(p => p.getAttribute('data-v'));
    expect(marks).toEqual(['b', 'b']);
  });
});

describe('StreamingMarkdown keeps block identity like the base render', () => {
  const mounts: string[] = [];
  const Img = ({ src }: { src: string }) => {
    useEffect(() => {
      mounts.push(src);
    }, [src]);
    return <img src={src} alt="" />;
  };
  const statefulComponents: Components = {
    img: ({ src }: ComponentProps<'img'>) => <Img src={String(src)} />,
  };

  it('does not remount a block when it moves from the live tail into the committed half', () => {
    mounts.length = 0;
    const frames = ['intro\n\n![x](https://e/x.png)', 'intro\n\n![x](https://e/x.png)\n\nnext para'];
    const { rerender } = render(<Subject text={frames[0]} streaming components={statefulComponents} />);
    rerender(<Subject text={frames[1]} streaming components={statefulComponents} />);
    expect(mounts).toEqual(['https://e/x.png']);
  });

  it('gives a code block the same node.position line while streaming as the base render', () => {
    const lines: number[] = [];
    const posComponents: Components = {
      code: ({ node, children }: ComponentProps<'code'> & ExtraProps) => {
        lines.push(node?.position?.start.line ?? -1);
        return <code>{children}</code>;
      },
    };
    const text = 'intro\n\nmore intro\n\n```ts\nconst a = 1;\n```';
    render(<Subject text={text} streaming components={posComponents} />);
    const streamed = lines.slice();
    lines.length = 0;
    render(
      <ReactMarkdown components={posComponents} remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>
        {text}
      </ReactMarkdown>
    );
    expect(streamed).toEqual(lines);
  });
});

describe('StreamingMarkdown with the reply image component', () => {
  const imageComponents: Components = {
    img: ({ src, alt }: ComponentProps<'img'>) => <ReplyMarkdownImage src={String(src)} alt={alt} />,
  };

  it('control: the base single ReactMarkdown keeps the approved image across the same frames', () => {
    const first = 'intro\n\n![chart](https://example.com/c.png)';
    const Base = ({ text }: { text: string }) => (
      <ReactMarkdown components={imageComponents} remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>
        {text}
      </ReactMarkdown>
    );
    const { rerender } = render(<Base text={first} />);
    fireEvent.click(screen.getByTestId('reply-image-load-btn'));
    rerender(<Base text={`${first}\n\nThe chart above shows`} />);
    expect(screen.queryByTestId('reply-image-load-btn')).toBeNull();
  });

  it('keeps a user-approved image loaded when more text streams in after it', () => {
    const first = 'intro\n\n![chart](https://example.com/c.png)';
    const { rerender } = render(<Subject text={first} streaming components={imageComponents} />);
    fireEvent.click(screen.getByTestId('reply-image-load-btn'));
    expect(screen.getByTestId('reply-image-loaded')).toBeTruthy();

    rerender(<Subject text={`${first}\n\nThe chart above shows`} streaming components={imageComponents} />);

    expect(screen.queryByTestId('reply-image-load-btn')).toBeNull();
    expect(screen.getByTestId('reply-image-loaded')).toBeTruthy();
  });
});
