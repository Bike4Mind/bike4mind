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
const remarkRehypeOptions: Options['remarkRehypeOptions'] = { clobberPrefix: 'fn-q2-' };

const Subject = ({ text, streaming, components }: { text: string; streaming: boolean; components: Components }) => (
  <StreamingMarkdown
    text={text}
    streaming={streaming}
    components={components}
    remarkPlugins={remarkPlugins}
    rehypePlugins={rehypePlugins}
    remarkRehypeOptions={remarkRehypeOptions}
  />
);

const Base = ({ text, components }: { text: string; components: Components }) => (
  <ReactMarkdown
    components={components}
    remarkPlugins={remarkPlugins}
    rehypePlugins={rehypePlugins}
    remarkRehypeOptions={remarkRehypeOptions}
  >
    {text}
  </ReactMarkdown>
);

describe('StreamingMarkdown completion transition keeps component state like the base render', () => {
  const imageComponents: Components = {
    img: ({ src, alt }: ComponentProps<'img'>) => <ReplyMarkdownImage src={String(src)} alt={alt} />,
  };
  const text = 'intro\n\n![chart](https://example.com/c.png)\n\nThe chart above shows growth.';

  it('control: the base single ReactMarkdown keeps an approved image when the reply completes', () => {
    const { rerender } = render(<Base text={text} components={imageComponents} />);
    fireEvent.click(screen.getByTestId('reply-image-load-btn'));
    rerender(<Base text={text} components={imageComponents} />);
    expect(screen.queryByTestId('reply-image-load-btn')).toBeNull();
  });

  it('keeps an image approved mid-stream (in a block after the first) loaded once streaming ends', () => {
    const { rerender } = render(<Subject text={text} streaming components={imageComponents} />);
    fireEvent.click(screen.getByTestId('reply-image-load-btn'));
    expect(screen.getByTestId('reply-image-loaded')).toBeTruthy();
    rerender(<Subject text={text} streaming={false} components={imageComponents} />);
    expect(screen.queryByTestId('reply-image-load-btn')).toBeNull();
    expect(screen.getByTestId('reply-image-loaded')).toBeTruthy();
  });

  it('does not remount code blocks after the first block when streaming ends', () => {
    const mounts: string[] = [];
    const Probe = ({ id }: { id: string }) => {
      useEffect(() => {
        mounts.push(id);
      }, [id]);
      return <code>{id}</code>;
    };
    const components: Components = {
      code: ({ children }: ComponentProps<'code'>) => <Probe id={String(children)} />,
    };
    const reply = 'first para\n\n```js\none\n```\n\nmiddle\n\n```js\ntwo\n```\n\nend';
    const { rerender } = render(<Subject text={reply} streaming components={components} />);
    expect(mounts.sort()).toEqual(['one\n', 'two\n']);
    mounts.length = 0;
    rerender(<Subject text={reply} streaming={false} components={components} />);
    expect(mounts).toEqual([]);
  });
});

type Seen = { tag: string; start: number; end: number; startCol: number; endCol: number };

const collectPositions = () => {
  const seen: Seen[] = [];
  const tags = ['code', 'pre', 'a', 'img', 'table', 'tr', 'td', 'th', 'li', 'h1', 'h2', 'h3', 'p', 'blockquote', 'br'];
  const components: Components = Object.fromEntries(
    tags.map(tag => [
      tag,
      ({ node, children }: { node?: ExtraProps['node']; children?: React.ReactNode }) => {
        const p = node?.position;
        seen.push({
          tag,
          start: p?.start.line ?? -1,
          end: p?.end.line ?? -1,
          startCol: p?.start.column ?? -1,
          endCol: p?.end.column ?? -1,
        });
        return React.createElement(tag === 'br' || tag === 'img' ? 'span' : tag, null, children);
      },
    ])
  );
  return { seen, components };
};

const POSITION_CORPUS: Record<string, string> = {
  table: 'intro\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\nafter\n\n```py\nx\n```',
  breaks: 'line one\nline two\nline three\n\nnext para\nwith break\n\n```sh\nls\n```',
  math: promoteInlineLatexDollars('intro\n\n$$\na = b\n$$\n\nInline $x^2$ here.\n\n```ts\nconst a = 1;\n```'),
  looseListWithCode: '1. step\n\n   ```sh\n   a\n   ```\n\n2. step two\n\n```js\nb\n```',
  blockquote: '> quote one\n>\n> quote two\n\n## Heading\n\n- [link](https://e.com)\n- ![i](https://e.com/i.png)',
  inlineCode: 'Use `npm i` then\n\n`yarn` and `pnpm`\n\n```\nblock\n```',
};

describe('node.position seen by components while streaming equals the single parse', () => {
  for (const [name, text] of Object.entries(POSITION_CORPUS)) {
    it(name, () => {
      const base = collectPositions();
      render(<Base text={text} components={base.components} />);
      const streamed = collectPositions();
      render(<Subject text={text} streaming components={streamed.components} />);
      const key = (s: Seen) => `${s.tag}:${s.start}-${s.end}:${s.start === s.end && s.startCol !== s.endCol}`;
      expect(streamed.seen.map(key).sort()).toEqual(base.seen.map(key).sort());
    });
  }
});

describe('footnote section placement while streaming', () => {
  it('never shows a footnote section mid-reply while streaming', () => {
    const text = 'Claim[^1] made.\n\n[^1]: Source.\n\nMore analysis follows here.\n\nAnd a conclusion';
    const { container: base } = render(<Base text={text} components={{}} />);
    const { container: streamed } = render(<Subject text={text} streaming components={{}} />);
    expect(base.lastElementChild?.tagName).toBe('SECTION');
    expect(streamed.querySelector('section')).toBeNull();
  });
});
