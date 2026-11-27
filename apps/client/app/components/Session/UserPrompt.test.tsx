// @vitest-environment jsdom
import { it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import UserPrompt from './UserPrompt';

vi.mock('./ImageContainer', () => ({
  default: ({ src, onSendMessage }: { src: string; onSendMessage?: (...args: unknown[]) => unknown }) => (
    <img data-testid="loaded-image" src={src} onClick={() => onSendMessage?.('hi')} />
  ),
}));
vi.mock('@client/app/components/common/HighlightedCode', () => ({
  default: ({ code }: { code: string }) => <pre data-testid="highlighted-code">{code}</pre>,
}));
vi.mock('@client/app/hooks/useContentTruncation', () => ({
  useContentTruncation: ({ content }: { content: string }) => ({
    needsTruncation: false,
    isExpanded: false,
    toggleExpanded: vi.fn(),
    displayContent: content,
  }),
}));
vi.mock('./CodeBlockHeader', () => ({
  default: ({ children, code }: { children: React.ReactNode; code: string }) => (
    <div data-testid="code-block-header" data-code={code}>
      {children}
    </div>
  ),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const ui = (prompt: string, onEdit = vi.fn(), onSendMessage = vi.fn()) => (
  <CssVarsProvider theme={appTheme}>
    <UserPrompt prompt={prompt} messageFiles={[]} onEdit={onEdit} onSendMessage={onSendMessage} />
  </CssVarsProvider>
);

const IMAGE_PROMPT = 'look ![t](https://evil.example/a.png) here';

it('does not load a prompt image until the viewer approves it', () => {
  const { container } = render(ui(IMAGE_PROMPT));
  expect(container.querySelector('img')).toBeNull();
  expect(screen.getByTestId('reply-image-load-btn')).toHaveTextContent('evil.example');
});

it('keeps an approved image mounted when the parent re-renders with new callbacks', () => {
  const { rerender } = render(ui(IMAGE_PROMPT));
  fireEvent.click(screen.getByTestId('reply-image-load-btn'));
  const img = screen.getByTestId('loaded-image');
  rerender(ui(IMAGE_PROMPT, vi.fn(), vi.fn()));
  expect(screen.getByTestId('loaded-image')).toBe(img);
  expect(screen.queryByTestId('reply-image-load-btn')).toBeNull();
});

it('sends through the latest onSendMessage after a re-render', () => {
  const first = vi.fn();
  const latest = vi.fn();
  const { rerender } = render(ui(IMAGE_PROMPT, vi.fn(), first));
  fireEvent.click(screen.getByTestId('reply-image-load-btn'));
  rerender(ui(IMAGE_PROMPT, vi.fn(), latest));
  fireEvent.click(screen.getByTestId('loaded-image'));
  expect(latest).toHaveBeenCalledWith('hi');
  expect(first).not.toHaveBeenCalled();
});

it('still renders text and fenced code', () => {
  render(ui('hello world\n\n```ts\nconst a = 1;\n```'));
  expect(screen.getByText('hello world')).toBeInTheDocument();
  expect(screen.getByTestId('highlighted-code')).toHaveTextContent('const a = 1;');
  expect(screen.getByTestId('code-block-header')).toHaveAttribute('data-code', 'const a = 1;\n');
});

it('draws empty fences as empty code blocks, not the word undefined', () => {
  const { container } = render(ui('```\n```\n\n```ts\n```'));
  const blocks = screen.getAllByTestId('highlighted-code');
  expect(blocks).toHaveLength(2);
  blocks.forEach(block => expect(block).toBeEmptyDOMElement());
  screen.getAllByTestId('code-block-header').forEach(header => expect(header).toHaveAttribute('data-code', ''));
  expect(container.textContent).not.toContain('undefined');
});
