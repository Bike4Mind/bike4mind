import React, { StrictMode, useEffect, type ComponentProps } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ReactMarkdown, { type Components, type Options } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import { assistantReplyRemarkPlugins } from '@client/app/utils/remarkPlugins';
import { remarkCitationMarkers } from './inlineCitations';
import { StreamingMarkdown } from './StreamingMarkdown';
import { ReplyMarkdownImage } from '../ReplyMarkdownImage';

vi.mock('../ImageContainer', () => ({
  default: ({ src }: { src: string }) => <img data-testid="reply-image-loaded" src={src} alt="" />,
}));

const plainPlugins: Options['remarkPlugins'] = [...assistantReplyRemarkPlugins];
const citedPlugins: Options['remarkPlugins'] = [...assistantReplyRemarkPlugins, remarkCitationMarkers];
const rehypePlugins: Options['rehypePlugins'] = [rehypeKatex];
const remarkRehypeOptions: Options['remarkRehypeOptions'] = { clobberPrefix: 'fn-q3-' };
const NO_COMPONENTS: Components = {};
const imageComponents: Components = {
  img: ({ src, alt }: ComponentProps<'img'>) => <ReplyMarkdownImage src={String(src)} alt={alt} />,
};

const Subject = ({
  text,
  streaming,
  components = NO_COMPONENTS,
  remarkPlugins = plainPlugins,
}: {
  text: string;
  streaming: boolean;
  components?: Components;
  remarkPlugins?: Options['remarkPlugins'];
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

const norm = (html: string) => html.replace(/ style=""/g, '');

const singleParse = (text: string, remarkPlugins: Options['remarkPlugins'] = plainPlugins) => {
  const { container } = render(
    <ReactMarkdown
      components={NO_COMPONENTS}
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      remarkRehypeOptions={remarkRehypeOptions}
    >
      {text}
    </ReactMarkdown>
  );
  const html = norm(container.innerHTML);
  cleanup();
  return html;
};

const streamedThenCompleted = (text: string, step: number, remarkPlugins: Options['remarkPlugins'] = plainPlugins) => {
  const { container, rerender } = render(
    <Subject text={text.slice(0, step)} streaming remarkPlugins={remarkPlugins} />
  );
  for (let i = step * 2; i < text.length; i += step) {
    rerender(<Subject text={text.slice(0, i)} streaming remarkPlugins={remarkPlugins} />);
  }
  rerender(<Subject text={text} streaming remarkPlugins={remarkPlugins} />);
  rerender(<Subject text={text} streaming={false} remarkPlugins={remarkPlugins} />);
  const html = norm(container.innerHTML);
  cleanup();
  return html;
};

const FRAGMENTS = [
  'Plain *em* and **strong** with `code`, https://example.com/x, [1] and [2, 3].',
  'Entities &amp; &copy; and ~~gone~~ text.',
  'Hard break  \nnext line',
  'Soft\nbreak',
  '## Heading ##',
  '# Top',
  'Title\n=====',
  'Para\n---',
  '---',
  '***',
  '* * *',
  '- a\n- b\n- c',
  '- a\n\n- b\n\n- c',
  '- a\n  - nested\n\n  - nested2\n- b',
  '- [ ] todo\n- [x] done',
  '1. one\n2. two',
  '1) one\n\n2) two',
  '3. three\n4. four',
  '> quote\n>\n> more',
  '> > nested\n>\n> outer',
  '> lazy\ncontinued',
  '```js\nconst a = 1;\n\nconst b = 2;\n```',
  '~~~\nx\n\ny\n~~~',
  '````md\n```\ninner\n```\n\nstill\n````',
  '1. step\n   ```bash\n   npm i\n\n   npm t\n   ```\n2. next',
  '- item\n\n  continued para\n\n  ```\n  code\n  ```',
  '$$\nx^2\n\n+ y\n$$',
  'Inline $$a+b$$ math.',
  '| a | b |\n|---|:-:|\n| 1 | 2 |',
  '![pic](https://example.com/i.png)',
  'text <!-- comment --> more',
  'trailing spaces   ',
  'Escaped \\* star',
  '<https://auto.example>',
  'www.example.com bare',
];
const SEPARATORS = ['\n\n', '\n\n', '\n\n\n'];

const corpus = (count: number) => {
  let seed = 20261030;
  const next = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  return Array.from({ length: count }, () => {
    let text = FRAGMENTS[next(FRAGMENTS.length)];
    const parts = 2 + next(7);
    for (let i = 1; i < parts; i++) text += SEPARATORS[next(SEPARATORS.length)] + FRAGMENTS[next(FRAGMENTS.length)];
    return text;
  });
};

describe('a reply that streamed here renders, once complete, exactly as the single parse', () => {
  it('matches the single parse DOM over a blank-separated grammar corpus, with and without citation markers', () => {
    const mismatches: string[] = [];
    corpus(400).forEach((text, k) => {
      for (const plugins of [plainPlugins, citedPlugins]) {
        if (streamedThenCompleted(text, k < 30 ? 3 : text.length, plugins) !== singleParse(text, plugins)) {
          mismatches.push(text);
        }
      }
    });
    expect(mismatches).toEqual([]);
  }, 60_000);

  it('keeps one loose list when an item has a lazy continuation line before the next item', () => {
    const text = 'Steps:\n\n1. **Install** the package\nwith npm\n\n2. Run it\n\n3. Check';
    expect(streamedThenCompleted(text, 3)).toBe(singleParse(text));
  });

  it('keeps a later code block whole after a list item that opens its fence on the marker line', () => {
    const text = '- ```\n  x\n  ```\n\nThen:\n\n```\ncode\n\nmore code\n```\n\nend';
    expect(streamedThenCompleted(text, 3)).toBe(singleParse(text));
  });

  it('keeps a later $$ block whole after a list item that opens math on the marker line', () => {
    const text = '- $$\n  x\n  $$\n\nThen:\n\n$$\na\n\nb\n$$\n\nend';
    expect(streamedThenCompleted(text, 3)).toBe(singleParse(text));
  });

  it.each([
    ['a blockquote', '> [docs]: https://docs.example\n\nSee [docs].\n\nend'],
    ['a list item', '- [docs]: https://docs.example\n\nSee [docs].\n\nend'],
    ['an escaped bracket label', '[a\\]b]: https://docs.example\n\nSee [a\\]b].\n\nend'],
  ])('resolves a reference whose definition sits in %s', (_, text) => {
    expect(streamedThenCompleted(text, 3)).toBe(singleParse(text));
  });

  it('control: a top-level definition still resolves (the single-parse fallback)', () => {
    const text = 'See [docs].\n\n[docs]: https://docs.example\n\nend';
    expect(streamedThenCompleted(text, 3)).toBe(singleParse(text));
  });
});

describe('text that only looks cross-block still keeps the blocks when the reply completes', () => {
  const approveThenComplete = (text: string) => {
    const { rerender } = render(<Subject text={text} streaming components={imageComponents} />);
    fireEvent.click(screen.getByTestId('reply-image-load-btn'));
    rerender(<Subject text={text} streaming={false} components={imageComponents} />);
  };

  it.each([
    [
      'an XML code block',
      'Config:\n\n```xml\n<dependency>\n  <groupId>x</groupId>\n</dependency>\n```\n\n![shot](https://example.com/s.png)\n\nDone.',
    ],
    ['a regex negated class', 'Use `/[^a-z]/g` to strip.\n\n![shot](https://example.com/s.png)\n\nDone.'],
    [
      'a TypeScript index signature',
      'Type:\n\n```ts\ninterface Bag {\n  [key: string]: number;\n}\n```\n\n![shot](https://example.com/s.png)\n\nDone.',
    ],
  ])('keeps an image approved mid-stream after completion when the reply has %s', (_, text) => {
    approveThenComplete(text);
    expect(screen.queryByTestId('reply-image-load-btn')).toBeNull();
    expect(screen.getByTestId('reply-image-loaded')).toBeTruthy();
  });

  it('does not remount a code block after the first when the reply contains an XML snippet', () => {
    const mounts: string[] = [];
    const Probe = ({ id }: { id: string }) => {
      useEffect(() => {
        mounts.push(id);
      }, [id]);
      return <code>{id}</code>;
    };
    const components: Components = { code: ({ children }: ComponentProps<'code'>) => <Probe id={String(children)} /> };
    const text = 'Intro\n\n```xml\n<b>x</b>\n```\n\nMiddle\n\n```js\ntwo\n```';
    const { rerender } = render(<Subject text={text} streaming components={components} />);
    mounts.length = 0;
    rerender(<Subject text={text} streaming={false} components={components} />);
    expect(mounts).toEqual([]);
  });
});

describe('streamedHere lifecycle', () => {
  it('keeps the blocks after completion under StrictMode double rendering', () => {
    const text = 'intro\n\n![chart](https://example.com/c.png)\n\nafter';
    const tree = (streaming: boolean) => (
      <StrictMode>
        <Subject text={text} streaming={streaming} components={imageComponents} />
      </StrictMode>
    );
    const { rerender } = render(tree(true));
    fireEvent.click(screen.getByTestId('reply-image-load-btn'));
    rerender(tree(false));
    expect(screen.getByTestId('reply-image-loaded')).toBeTruthy();
  });

  it('does not carry an approval to a different image at the same block index when a stopped reply is retried', () => {
    const first = 'intro\n\n![old](https://example.com/old.png)\n\n```js\nopen fence';
    const { rerender } = render(<Subject text={first} streaming components={imageComponents} />);
    fireEvent.click(screen.getByTestId('reply-image-load-btn'));
    rerender(<Subject text={first} streaming={false} components={imageComponents} />);
    rerender(<Subject text="" streaming components={imageComponents} />);
    const retry = 'other\n\n![new](https://example.com/new.png)\n\nend';
    rerender(<Subject text={retry} streaming components={imageComponents} />);
    expect(screen.getByTestId('reply-image-load-btn')).toBeTruthy();
    expect(screen.queryByTestId('reply-image-loaded')).toBeNull();
  });

  it('renders a stopped reply with an open fence in the tail like the single parse', () => {
    const text = 'Here:\n\n```py\nprint(1)\n\nprint(2)';
    expect(streamedThenCompleted(text, 3)).toBe(singleParse(text));
  });
});

describe('cost of re-rendering a completed reply that streamed here', () => {
  it('re-renders a 200 KB completed reply with many unterminated bracket lines in under 100 ms', () => {
    const text = 'Log:\n\n' + '[ unterminated bracket line\n'.repeat(8000);
    const { rerender } = render(<Subject text={text} streaming />);
    rerender(<Subject text={text} streaming={false} />);
    const start = performance.now();
    rerender(<Subject text={text} streaming={false} />);
    expect(performance.now() - start).toBeLessThan(100);
  }, 120_000);
});
