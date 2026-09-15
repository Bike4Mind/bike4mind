import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { HtmlArtifact } from '@bike4mind/common';

vi.mock('dompurify', () => ({ default: { sanitize: vi.fn((content: string) => content) } }));
vi.mock('@client/app/utils/artifactParser', () => ({
  validateArtifactContent: vi.fn(() => ({ isValid: true, errors: [] })),
}));

import HtmlArtifactViewer from '../HtmlArtifactViewer';
import { validateArtifactContent } from '@client/app/utils/artifactParser';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

beforeEach(() => {
  vi.mocked(validateArtifactContent).mockReturnValue({ isValid: true, errors: [] });
});

const makeArtifact = (overrides: Partial<HtmlArtifact> = {}): HtmlArtifact => ({
  id: 'test-id',
  type: 'html',
  title: 'Test HTML',
  content: '<p>Hello World</p>',
  metadata: { allowedScripts: [], sanitized: true },
  version: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe('HtmlArtifactViewer', () => {
  it('renders iframe pointing to artifact sandbox', async () => {
    render(
      <TestWrapper>
        <HtmlArtifactViewer artifact={makeArtifact()} />
      </TestWrapper>
    );

    await waitFor(() => {
      const iframe = document.querySelector('iframe');
      expect(iframe).not.toBeNull();
      expect(iframe?.getAttribute('src')).toBe('/api/artifact-sandbox');
    });
  });

  it('sandbox does not include allow-same-origin', async () => {
    render(
      <TestWrapper>
        <HtmlArtifactViewer artifact={makeArtifact()} />
      </TestWrapper>
    );

    await waitFor(() => {
      const iframe = document.querySelector('iframe');
      expect(iframe?.getAttribute('sandbox')).not.toContain('allow-same-origin');
    });
  });

  it('sandbox grants allow-scripts only — form submission blocked at the sandbox layer (CSP form-action none is the second gate)', async () => {
    render(
      <TestWrapper>
        <HtmlArtifactViewer artifact={makeArtifact()} />
      </TestWrapper>
    );

    await waitFor(() => {
      const iframe = document.querySelector('iframe');
      const sandbox = iframe?.getAttribute('sandbox') ?? '';
      expect(sandbox).toContain('allow-scripts');
      expect(sandbox).not.toContain('allow-forms');
    });
  });

  it('posts artifact HTML to sandbox contentWindow on ready signal', async () => {
    const postMessageMock = vi.fn();

    render(
      <TestWrapper>
        <HtmlArtifactViewer artifact={makeArtifact()} />
      </TestWrapper>
    );

    const iframe = await waitFor(() => {
      const el = document.querySelector('iframe');
      expect(el).not.toBeNull();
      return el!;
    });

    // Simulate the sandbox signalling ready from the iframe's contentWindow
    const mockContentWindow = { postMessage: postMessageMock };
    Object.defineProperty(iframe, 'contentWindow', {
      value: mockContentWindow,
      writable: true,
      configurable: true,
    });

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'artifact-sandbox-ready' },
          source: mockContentWindow as unknown as Window,
        })
      );
    });

    expect(postMessageMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'artifact-html' }), '*');
  });

  it('absolutizes root-relative /static script srcs to the app origin in posted HTML', async () => {
    const postMessageMock = vi.fn();

    render(
      <TestWrapper>
        <HtmlArtifactViewer
          artifact={makeArtifact({
            content: '<script src="/static/lib/chart.js@4.x.js"></script><canvas id="c"></canvas>',
          })}
        />
      </TestWrapper>
    );

    const iframe = await waitFor(() => {
      const el = document.querySelector('iframe');
      expect(el).not.toBeNull();
      return el!;
    });

    const mockContentWindow = { postMessage: postMessageMock };
    Object.defineProperty(iframe, 'contentWindow', {
      value: mockContentWindow,
      writable: true,
      configurable: true,
    });

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'artifact-sandbox-ready' },
          source: mockContentWindow as unknown as Window,
        })
      );
    });

    const posted = postMessageMock.mock.calls[0][0];
    expect(posted.type).toBe('artifact-html');
    // jsdom origin is http://localhost; the root-relative blessed src is absolutized to it.
    expect(posted.content).toContain(`src="${window.location.origin}/static/lib/chart.js@4.x.js"`);
    expect(posted.content).not.toContain('src="/static/lib/chart.js@4.x.js"');
  });

  it('shows error alert when validation fails', async () => {
    vi.mocked(validateArtifactContent).mockReturnValueOnce({ isValid: false, errors: ['Content too large'] });

    render(
      <TestWrapper>
        <HtmlArtifactViewer artifact={makeArtifact({ content: '' })} />
      </TestWrapper>
    );

    await waitFor(() => {
      expect(screen.getByText(/Content too large/i)).toBeDefined();
    });
  });
});
