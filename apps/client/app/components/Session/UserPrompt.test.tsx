// @vitest-environment jsdom
import { it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import UserPrompt from './UserPrompt';

vi.mock('./ImageContainer', () => ({
  default: ({ src }: { src: string }) => <img data-testid="loaded-image" src={src} />,
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
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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

it('still renders text and fenced code', () => {
  render(ui('hello world\n\n```ts\nconst a = 1;\n```'));
  expect(screen.getByText('hello world')).toBeInTheDocument();
  expect(screen.getByTestId('highlighted-code')).toHaveTextContent('const a = 1;');
});
