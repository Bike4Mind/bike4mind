import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';
import { ShareActions } from './ShareActions';

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const TITLE = 'My shared reply';
const URL = 'https://app.bike4mind.com/p/r/abc123';

describe('ShareActions', () => {
  let openedHrefs: string[];
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // ShareActions opens links via openInNewTab(), which clicks a transient
    // <a target="_blank" rel="noopener noreferrer"> rather than calling
    // window.open. Capture the href of each opened anchor, in order.
    openedHrefs = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      openedHrefs.push(this.getAttribute('href') ?? '');
    });
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    // No native share by default -> Copy Link fallback path
    Object.assign(navigator, { share: undefined });
    toastSuccess.mockClear();
    toastError.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('full variant renders the social buttons', () => {
    render(
      <Wrapper>
        <ShareActions title={TITLE} url={URL} />
      </Wrapper>
    );
    expect(screen.getByTestId('share-actions-bluesky')).toBeTruthy();
    expect(screen.getByTestId('share-actions-twitter')).toBeTruthy();
    expect(screen.getByTestId('share-actions-linkedin')).toBeTruthy();
    expect(screen.getByTestId('share-actions-copy-link')).toBeTruthy();
    // Copy Markdown only appears when markdown is provided
    expect(screen.queryByTestId('share-actions-copy-markdown')).toBeNull();
  });

  it('shows Copy Markdown only when markdown prop is provided', () => {
    render(
      <Wrapper>
        <ShareActions title={TITLE} url={URL} markdown="# hello" />
      </Wrapper>
    );
    expect(screen.getByTestId('share-actions-copy-markdown')).toBeTruthy();
  });

  it('icon variant renders a single share icon button', () => {
    render(
      <Wrapper>
        <ShareActions title={TITLE} url={URL} variant="icon" />
      </Wrapper>
    );
    expect(screen.getByTestId('share-actions-icon-btn')).toBeTruthy();
    expect(screen.queryByTestId('share-actions-bluesky')).toBeNull();
  });

  it('Copy Link writes the URL to the clipboard and toasts success', async () => {
    render(
      <Wrapper>
        <ShareActions title={TITLE} url={URL} />
      </Wrapper>
    );
    fireEvent.click(screen.getByTestId('share-actions-copy-link'));
    expect(writeText).toHaveBeenCalledWith(URL);
    await Promise.resolve();
    expect(toastSuccess).toHaveBeenCalled();
  });

  it('Twitter button opens the intent URL with encoded title + url', () => {
    render(
      <Wrapper>
        <ShareActions title={TITLE} url={URL} />
      </Wrapper>
    );
    fireEvent.click(screen.getByTestId('share-actions-twitter'));
    expect(openedHrefs).toHaveLength(1);
    const opened = openedHrefs[0];
    expect(opened).toContain('twitter.com/intent/tweet');
    expect(opened).toContain(encodeURIComponent(URL));
    expect(opened).toContain(encodeURIComponent(TITLE));
  });

  it('LinkedIn button opens the share-offsite URL', () => {
    render(
      <Wrapper>
        <ShareActions title={TITLE} url={URL} />
      </Wrapper>
    );
    fireEvent.click(screen.getByTestId('share-actions-linkedin'));
    const opened = openedHrefs[0];
    expect(opened).toContain('linkedin.com/sharing/share-offsite');
    expect(opened).toContain(encodeURIComponent(URL));
  });

  it('Copy Markdown copies the markdown body', async () => {
    render(
      <Wrapper>
        <ShareActions title={TITLE} url={URL} markdown="# hello world" />
      </Wrapper>
    );
    fireEvent.click(screen.getByTestId('share-actions-copy-markdown'));
    expect(writeText).toHaveBeenCalledWith('# hello world');
    await Promise.resolve();
    expect(toastSuccess).toHaveBeenCalled();
  });
});

describe('ShareActions - brand label contrast', () => {
  const luminance = (rgb: number[]) => {
    const [r, g, b] = rgb.map(c => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a: number[], b: number[]) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const hex = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  // Modal popup, panel surface and the outlined-button hover fill, per mode.
  const BACKGROUNDS = {
    light: ['#FFFFFF', '#F4F7F9', '#E3EFFB'],
    dark: ['#000000', '#0E1214', '#0A2744'],
  } as const;

  it.each(['light', 'dark'] as const)('%s: every brand-coloured label reaches 4.5:1', mode => {
    render(
      <CssVarsProvider theme={appTheme} defaultMode={mode} modeStorageKey={`share-actions-test-${mode}`}>
        <ShareActions title={TITLE} url={URL} markdown="# hi" />
      </CssVarsProvider>
    );
    const failures = ['bluesky', 'linkedin', 'copy-markdown'].flatMap(id => {
      const rgb = getComputedStyle(screen.getByTestId(`share-actions-${id}`))
        .color.match(/\d+/g)!
        .slice(0, 3)
        .map(Number);
      return BACKGROUNDS[mode]
        .map(bg => ({ id, bg, ratio: contrast(rgb, hex(bg)) }))
        .filter(({ ratio }) => ratio < 4.5)
        .map(({ bg, ratio }) => `${id} on ${bg}: ${ratio.toFixed(2)}`);
    });
    expect(failures).toEqual([]);
  });
});
