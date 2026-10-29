import React, { type ComponentProps } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import ReactMarkdown, { type Components } from 'react-markdown';
import { StreamingMarkdown } from './StreamingMarkdown';

vi.mock('react-markdown', async importOriginal => {
  const actual = await importOriginal<typeof import('react-markdown')>();
  return { ...actual, default: vi.fn(actual.default) };
});

const NO_PLUGINS: never[] = [];
const REMARK_REHYPE = {};

const renderCounts = new Map<string, number>();
const countingComponents: Components = {
  p: ({ children }: ComponentProps<'p'>) => {
    const key = String(children);
    renderCounts.set(key, (renderCounts.get(key) ?? 0) + 1);
    return <p>{children}</p>;
  },
  code: ({ children, className }: ComponentProps<'code'>) => (
    <code data-testid="md-code" className={className}>
      {children}
    </code>
  ),
};

const Subject = ({ text, streaming }: { text: string; streaming: boolean }) => (
  <StreamingMarkdown
    text={text}
    streaming={streaming}
    components={countingComponents}
    remarkPlugins={NO_PLUGINS}
    rehypePlugins={NO_PLUGINS}
    remarkRehypeOptions={REMARK_REHYPE}
  />
);

beforeEach(() => {
  renderCounts.clear();
  vi.mocked(ReactMarkdown).mockClear();
});

describe('StreamingMarkdown', () => {
  it('renders a completed reply through one ReactMarkdown', () => {
    const text = 'first\n\nsecond\n\nthird';
    render(<Subject text={text} streaming={false} />);

    expect(ReactMarkdown).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ReactMarkdown).mock.calls[0][0].children).toBe(text);
    expect(screen.getByText('third')).toBeTruthy();
  });

  it('does not re-render the committed half when only the tail grows', () => {
    const prefix = 'alpha paragraph\n\nbeta paragraph\n\n';
    const { rerender } = render(<Subject text={`${prefix}gamma`} streaming />);
    expect(renderCounts.get('alpha paragraph')).toBe(1);
    expect(renderCounts.get('beta paragraph')).toBe(1);

    rerender(<Subject text={`${prefix}gamma and twenty more ch`} streaming />);

    expect(renderCounts.get('alpha paragraph')).toBe(1);
    expect(renderCounts.get('beta paragraph')).toBe(1);
    expect(screen.getByText('gamma and twenty more ch')).toBeTruthy();
  });

  it('keeps an open fence in the tail as a code element', () => {
    render(<Subject text={'intro\n\n```ts\nconst a = 1;\n'} streaming />);

    const code = screen.getByTestId('md-code');
    expect(code.textContent).toContain('const a = 1;');
    expect(code.className).toContain('language-ts');
  });
});
