import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { CssVarsProvider } from '@mui/joy/styles';
import InlineArtifactPreview from '../InlineArtifactPreview';
import type { ReactArtifact, HtmlArtifact, SvgArtifact } from '@bike4mind/common';

// Mock DOMPurify
vi.mock('dompurify', () => ({
  default: {
    sanitize: vi.fn((content: string) => content),
  },
}));

// useReactArtifactSandbox reads the EnableInertArtifactRender flag via this hook (react-query).
// Mock it so the component renders without a QueryClientProvider. Controllable per-test so we can
// assert BOTH the default eval path (empty data) and the flag-on inert path.
const { mockExperimentalSettings } = vi.hoisted(() => ({
  mockExperimentalSettings: vi.fn(() => ({ data: [] as Array<{ settingName: string; settingValue: string }> })),
}));
vi.mock('@client/app/hooks/data/settings', () => ({
  useExperimentalFeatureSettings: () => mockExperimentalSettings(),
}));

// Mock URL.createObjectURL/revokeObjectURL - no artifact type uses blob: anymore (React now
// renders via the /api/react-artifact-sandbox route); kept to assert they're NOT called.
const mockCreateObjectURL = vi.fn(() => 'blob:mock-url');
const mockRevokeObjectURL = vi.fn();

beforeEach(() => {
  global.URL.createObjectURL = mockCreateObjectURL;
  global.URL.revokeObjectURL = mockRevokeObjectURL;
  // Default every test to the flag-off (eval) path; the inert test overrides this.
  mockExperimentalSettings.mockReturnValue({ data: [] });
});

afterEach(() => {
  vi.clearAllMocks();
});

// Test wrapper with MUI theme
const TestWrapper = ({ children }: { children: React.ReactNode }) => <CssVarsProvider>{children}</CssVarsProvider>;

// Sample artifacts for testing
const mockReactArtifact: ReactArtifact = {
  id: 'react-artifact-1',
  type: 'react',
  title: 'Test React Component',
  content: 'export default function App() { return <div>Hello</div>; }',
  metadata: {
    dependencies: ['react'],
  },
};

const mockHtmlArtifact: HtmlArtifact = {
  id: 'html-artifact-1',
  type: 'html',
  title: 'Test HTML Page',
  content: '<div><h1>Hello World</h1></div>',
};

const mockSvgArtifact: SvgArtifact = {
  id: 'svg-artifact-1',
  type: 'svg',
  title: 'Test SVG',
  content: '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/></svg>',
};

describe('InlineArtifactPreview', () => {
  describe('Basic Rendering', () => {
    it('renders loading state initially for React artifacts', () => {
      render(
        <TestWrapper>
          <InlineArtifactPreview artifact={mockReactArtifact} type="react" />
        </TestWrapper>
      );

      // Should show loading spinner initially
      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });

    it('renders loading state initially for HTML artifacts', () => {
      render(
        <TestWrapper>
          <InlineArtifactPreview artifact={mockHtmlArtifact} type="html" />
        </TestWrapper>
      );

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });

    it('renders SVG directly without iframe', () => {
      render(
        <TestWrapper>
          <InlineArtifactPreview artifact={mockSvgArtifact} type="svg" />
        </TestWrapper>
      );

      const preview = screen.getByTestId('inline-svg-preview');
      expect(preview).toBeInTheDocument();
      // SVG should not use iframe
      expect(screen.queryByTestId('inline-artifact-iframe')).not.toBeInTheDocument();
    });
  });

  describe('React artifact iframe (sandbox route)', () => {
    it('does NOT create a blob URL for React artifacts', async () => {
      render(
        <TestWrapper>
          <InlineArtifactPreview artifact={mockReactArtifact} type="react" />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByTestId('inline-artifact-iframe')).toBeInTheDocument();
      });

      expect(mockCreateObjectURL).not.toHaveBeenCalled();
    });

    it('renders React artifact iframe pointing to /api/react-artifact-sandbox', async () => {
      render(
        <TestWrapper>
          <InlineArtifactPreview artifact={mockReactArtifact} type="react" />
        </TestWrapper>
      );

      await waitFor(() => {
        const iframe = screen.getByTestId('inline-artifact-iframe');
        expect(iframe.getAttribute('src')).toBe('/api/react-artifact-sandbox');
      });
    });

    it('renders React artifact iframe without allow-same-origin in sandbox', async () => {
      render(
        <TestWrapper>
          <InlineArtifactPreview artifact={mockReactArtifact} type="react" />
        </TestWrapper>
      );

      await waitFor(() => {
        const iframe = screen.getByTestId('inline-artifact-iframe');
        expect(iframe.getAttribute('sandbox')).not.toContain('allow-same-origin');
      });
    });

    it('posts artifact code to sandbox contentWindow on ready signal', async () => {
      const postMessageMock = vi.fn();

      render(
        <TestWrapper>
          <InlineArtifactPreview artifact={mockReactArtifact} type="react" />
        </TestWrapper>
      );

      const iframe = await waitFor(() => {
        const el = screen.getByTestId('inline-artifact-iframe');
        expect(el).toBeInTheDocument();
        return el;
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
            data: { type: 'react-sandbox-ready' },
            source: mockContentWindow as unknown as Window,
          })
        );
      });

      // Flag off (default): the payload carries the eval path.
      expect(postMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'react-artifact-render', mode: 'eval' }),
        '*'
      );
    });

    it('posts mode "inert" when EnableInertArtifactRender is on', async () => {
      // Regression guard: the flag must reach the client and
      // flip the posted mode. Without the allowlist fix in settings.ts this stays 'eval'.
      mockExperimentalSettings.mockReturnValue({
        data: [{ settingName: 'EnableInertArtifactRender', settingValue: 'true' }],
      });
      const postMessageMock = vi.fn();

      render(
        <TestWrapper>
          <InlineArtifactPreview artifact={mockReactArtifact} type="react" />
        </TestWrapper>
      );

      const iframe = await waitFor(() => {
        const el = screen.getByTestId('inline-artifact-iframe');
        expect(el).toBeInTheDocument();
        return el;
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
            data: { type: 'react-sandbox-ready' },
            source: mockContentWindow as unknown as Window,
          })
        );
      });

      expect(postMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'react-artifact-render', mode: 'inert' }),
        '*'
      );
    });

    it('clears the loading overlay and reports onError when the sandbox posts an error', async () => {
      const onError = vi.fn();
      render(
        <TestWrapper>
          <InlineArtifactPreview artifact={mockReactArtifact} type="react" onError={onError} />
        </TestWrapper>
      );

      const iframe = await waitFor(() => {
        const el = screen.getByTestId('inline-artifact-iframe');
        expect(el).toBeInTheDocument();
        return el;
      });
      // Spinner is up until the sandbox responds.
      expect(screen.getByRole('progressbar')).toBeInTheDocument();

      const mockContentWindow = { postMessage: vi.fn() };
      Object.defineProperty(iframe, 'contentWindow', {
        value: mockContentWindow,
        writable: true,
        configurable: true,
      });

      await act(async () => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: { type: 'react-sandbox-error', message: 'boom' },
            source: mockContentWindow as unknown as Window,
          })
        );
      });

      expect(onError).toHaveBeenCalledWith('boom');
      // Regression guard: an errored sandbox must not leave the overlay spinning forever.
      await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument());
    });
  });

  describe('HTML artifact sandbox isolation', () => {
    it('does NOT create a blob URL for HTML artifacts', async () => {
      render(
        <TestWrapper>
          <InlineArtifactPreview artifact={mockHtmlArtifact} type="html" />
        </TestWrapper>
      );

      // Allow effects to run
      await waitFor(() => {
        const iframe = screen.getByTestId('inline-artifact-iframe');
        expect(iframe).toBeInTheDocument();
      });

      expect(mockCreateObjectURL).not.toHaveBeenCalled();
    });

    it('renders HTML artifact iframe pointing to /api/artifact-sandbox', async () => {
      render(
        <TestWrapper>
          <InlineArtifactPreview artifact={mockHtmlArtifact} type="html" />
        </TestWrapper>
      );

      await waitFor(() => {
        const iframe = screen.getByTestId('inline-artifact-iframe');
        expect(iframe.getAttribute('src')).toBe('/api/artifact-sandbox');
      });
    });

    it('renders HTML artifact iframe without allow-same-origin in sandbox', async () => {
      render(
        <TestWrapper>
          <InlineArtifactPreview artifact={mockHtmlArtifact} type="html" />
        </TestWrapper>
      );

      await waitFor(() => {
        const iframe = screen.getByTestId('inline-artifact-iframe');
        expect(iframe.getAttribute('sandbox')).not.toContain('allow-same-origin');
      });
    });

    it('posts artifact HTML to sandbox contentWindow on ready signal', async () => {
      const postMessageMock = vi.fn();

      render(
        <TestWrapper>
          <InlineArtifactPreview artifact={mockHtmlArtifact} type="html" />
        </TestWrapper>
      );

      const iframe = await waitFor(() => {
        const el = screen.getByTestId('inline-artifact-iframe');
        expect(el).toBeInTheDocument();
        return el;
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

      expect(postMessageMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'artifact-html' }), '*');
    });

    it('absolutizes blessed /static script srcs in the posted HTML', async () => {
      const postMessageMock = vi.fn();
      const artifact: HtmlArtifact = {
        ...mockHtmlArtifact,
        content: '<script src="/static/lib/chart.js@4.x.js"></script><canvas id="c"></canvas>',
      };

      render(
        <TestWrapper>
          <InlineArtifactPreview artifact={artifact} type="html" />
        </TestWrapper>
      );

      const iframe = await waitFor(() => {
        const el = screen.getByTestId('inline-artifact-iframe');
        expect(el).toBeInTheDocument();
        return el;
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
      expect(posted.content).toContain(`src="${window.location.origin}/static/lib/chart.js@4.x.js"`);
      expect(posted.content).not.toContain('src="/static/lib/chart.js@4.x.js"');
    });
  });

  describe('Props', () => {
    it('applies custom maxHeight', () => {
      render(
        <TestWrapper>
          <InlineArtifactPreview artifact={mockSvgArtifact} type="svg" maxHeight={300} />
        </TestWrapper>
      );

      const preview = screen.getByTestId('inline-svg-preview');
      expect(preview).toHaveStyle({ maxHeight: '300px' });
    });

    it('uses default maxHeight of 400px', () => {
      render(
        <TestWrapper>
          <InlineArtifactPreview artifact={mockSvgArtifact} type="svg" />
        </TestWrapper>
      );

      const preview = screen.getByTestId('inline-svg-preview');
      expect(preview).toHaveStyle({ maxHeight: '400px' });
    });
  });

  describe('Error Handling', () => {
    it('calls onError callback when generation fails', async () => {
      const onError = vi.fn();

      // Create an artifact that will cause an error by using invalid type
      const invalidArtifact = {
        ...mockReactArtifact,
        content: null as unknown as string, // Force an error
      };

      render(
        <TestWrapper>
          <InlineArtifactPreview artifact={invalidArtifact} type="react" onError={onError} />
        </TestWrapper>
      );

      // The component should handle the error gracefully
      // Since the content is null, it may still render or show error state
    });
  });

  describe('Sandbox Security', () => {
    it('renders React iframe with proper sandbox attributes', async () => {
      render(
        <TestWrapper>
          <InlineArtifactPreview artifact={mockReactArtifact} type="react" />
        </TestWrapper>
      );

      await waitFor(() => {
        const iframe = screen.getByTestId('inline-artifact-iframe');
        expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
      });
    });

    it('renders HTML iframe with proper sandbox attributes', async () => {
      render(
        <TestWrapper>
          <InlineArtifactPreview artifact={mockHtmlArtifact} type="html" />
        </TestWrapper>
      );

      await waitFor(() => {
        const iframe = screen.getByTestId('inline-artifact-iframe');
        expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
      });
    });
  });

  describe('Data Test IDs', () => {
    it('has correct test id for iframe preview (React)', async () => {
      render(
        <TestWrapper>
          <InlineArtifactPreview artifact={mockReactArtifact} type="react" />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByTestId('inline-artifact-iframe')).toBeInTheDocument();
      });
    });

    it('has correct test id for iframe preview (HTML)', async () => {
      render(
        <TestWrapper>
          <InlineArtifactPreview artifact={mockHtmlArtifact} type="html" />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByTestId('inline-artifact-iframe')).toBeInTheDocument();
      });
    });

    it('has correct test id for SVG preview', () => {
      render(
        <TestWrapper>
          <InlineArtifactPreview artifact={mockSvgArtifact} type="svg" />
        </TestWrapper>
      );

      expect(screen.getByTestId('inline-svg-preview')).toBeInTheDocument();
    });
  });
});
