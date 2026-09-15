import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import DownloadMenu from './DownloadMenu';

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderMenu = (props: Partial<React.ComponentProps<typeof DownloadMenu>> = {}) =>
  render(<DownloadMenu content="" fileName="reply.md" {...props} />, { wrapper: Wrapper });

// The MenuButton is this component's only button when rendered in isolation.
const openMenu = () => fireEvent.click(screen.getByRole('button'));

const CSV_REPLY = ['Here is the data:', '```csv', 'a,b,c', '1,2,3', '```'].join('\n');
const PYTHON_REPLY = ['```python', 'def main():', '    print("hi")', '```'].join('\n');
const PROSE_REPLY = 'Sure, here is a plain explanation with no code blocks at all.';

// jsdom implements neither URL method; downloadFile() (used by every menu item) calls both.
// The anchor itself is captured via document.createElement rather than `this` inside the
// click spy, since aliasing `this` to a variable trips @typescript-eslint/no-this-alias.
function stubDownloadApis() {
  const createObjectURL = vi.fn((_blob: Blob) => 'blob:mock-url');
  const revokeObjectURL = vi.fn((_url: string) => undefined);
  Object.assign(URL, { createObjectURL, revokeObjectURL });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

  const anchors: HTMLAnchorElement[] = [];
  const realCreateElement = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tagName: string, options?: ElementCreationOptions) => {
    const el = realCreateElement(tagName, options);
    if (tagName === 'a') anchors.push(el as HTMLAnchorElement);
    return el;
  }) as typeof document.createElement);

  return { createObjectURL, revokeObjectURL, getAnchor: () => anchors[anchors.length - 1] };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DownloadMenu', () => {
  it('does not compute or render detected items before the menu is opened', () => {
    renderMenu({ content: CSV_REPLY });
    expect(screen.queryAllByTestId(/^download-menu-detected-/)).toHaveLength(0);
  });

  it('opening the menu on a csv-fenced reply renders a detected item above the static ones', () => {
    renderMenu({ content: CSV_REPLY, fileName: 'reply.md' });
    openMenu();

    const detected = screen.queryAllByTestId(/^download-menu-detected-/);
    expect(detected).toHaveLength(1);
    expect(detected[0].getAttribute('data-testid')).toBe('download-menu-detected-reply-1.csv');
    expect(screen.getByText('Markdown')).toBeInTheDocument();
    expect(screen.getByText('DOCX')).toBeInTheDocument();
    expect(screen.getByText('HTML')).toBeInTheDocument();
  });

  it('opening the menu on a prose reply with no fences renders only the three static items', () => {
    renderMenu({ content: PROSE_REPLY });
    openMenu();

    expect(screen.queryAllByTestId(/^download-menu-detected-/)).toHaveLength(0);
    expect(screen.getByText('Markdown')).toBeInTheDocument();
    expect(screen.getByText('DOCX')).toBeInTheDocument();
    expect(screen.getByText('HTML')).toBeInTheDocument();
  });

  it('clicking a detected item downloads its own content under its own filename and mime type', () => {
    const { createObjectURL, revokeObjectURL, getAnchor } = stubDownloadApis();
    renderMenu({ content: CSV_REPLY, fileName: 'reply.md' });
    openMenu();
    fireEvent.click(screen.getByTestId('download-menu-detected-reply-1.csv'));

    expect(getAnchor()?.download).toBe('reply-1.csv');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(createObjectURL.mock.calls[0][0].type).toBe('text/csv');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });

  it('a python fence produces a detected entry whose filename ends .py', () => {
    renderMenu({ content: PYTHON_REPLY, fileName: 'reply.md' });
    openMenu();

    const detected = screen.queryAllByTestId(/^download-menu-detected-/);
    expect(detected).toHaveLength(1);
    expect(detected[0].getAttribute('data-testid')).toMatch(/\.py$/);
  });

  it('clicking a detected item calls onClose', () => {
    stubDownloadApis();
    const onClose = vi.fn();
    renderMenu({ content: CSV_REPLY, fileName: 'reply.md', onClose });
    openMenu();
    fireEvent.click(screen.getByTestId('download-menu-detected-reply-1.csv'));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
