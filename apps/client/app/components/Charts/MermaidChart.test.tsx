/**
 * @vitest-environment jsdom
 *
 * MermaidChart Component Tests
 *
 * TESTING STRATEGY:
 * ================
 * This test suite focuses on component logic and user interactions.
 *
 * WHAT IS TESTED (Unit Tests):
 * - Tab switching between Chart and Source
 * - Copy button tooltip changes based on active tab
 * - Copy button behavior (context-aware: source code on Source tab, PNG on Chart tab)
 * - Code button copies definition on both tabs
 * - Read-only vs editable mode display
 * - Local definition state updates
 * - Error display when Mermaid rendering fails
 * - Clipboard error handling
 *
 * WHAT IS NOT TESTED (Delegated to QA Automation Team):
 * - PNG export/copy functionality (requires complex DOM/Canvas/Image mocking that is brittle)
 * - Download button functionality (relies on browser download behavior)
 * - Actual Mermaid chart rendering (integration concern)
 * - Actual clipboard operations (browser API)
 *
 * REASON: The QA Automation team handles integration tests using Playwright.
 * Repository: https://github.com/MillionOnMars/B4MPlaywrightTests
 * These unit tests verify component logic while Playwright tests verify browser APIs.
 *
 * NOTE: All interactive elements have data-testid attributes for Playwright testing.
 * QA Automation team can use: page.getByTestId('mermaid-copy-btn')
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import MermaidChart from './MermaidChart';
import { useSnackbar } from '@client/app/contexts/SnackbarContext';

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({
      svg: '<svg width="100" height="100" viewBox="0 0 100 100"><rect width="100" height="100" /></svg>',
    }),
  },
}));

vi.mock('@client/app/contexts/SnackbarContext', () => ({
  useSnackbar: vi.fn(),
}));

// Setup clipboard mock (only for text operations, not PNG operations)
Object.defineProperty(navigator, 'clipboard', {
  value: {
    writeText: vi.fn(),
  },
  writable: true,
  configurable: true,
});

describe('MermaidChart', () => {
  let mockShowSnackbar: ReturnType<typeof vi.fn>;
  const mockChartDefinition = 'graph TD\n  A-->B';

  beforeEach(() => {
    mockShowSnackbar = vi.fn();

    vi.mocked(useSnackbar).mockReturnValue({
      showSnackbar: mockShowSnackbar,
    });

    vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  describe('Rendering', () => {
    it('should render with Chart tab active by default', () => {
      render(<MermaidChart chartDefinition={mockChartDefinition} />);

      const chartTab = screen.getByTestId('mermaid-chart-tab');
      const sourceTab = screen.getByTestId('mermaid-source-tab');

      expect(chartTab).toHaveAttribute('aria-selected', 'true');
      expect(sourceTab).toHaveAttribute('aria-selected', 'false');
    });

    it('should render title and description when provided', () => {
      render(<MermaidChart chartDefinition={mockChartDefinition} title="Test Chart" description="Test Description" />);

      expect(screen.getByText('Test Chart')).toBeInTheDocument();
      expect(screen.getByText('Test Description')).toBeInTheDocument();
    });

    it('should render all action buttons', () => {
      render(<MermaidChart chartDefinition={mockChartDefinition} />);

      expect(screen.getByTestId('mermaid-copy-definition-btn')).toBeInTheDocument();
      expect(screen.getByTestId('mermaid-copy-btn')).toBeInTheDocument();
      expect(screen.getByTestId('mermaid-download-btn')).toBeInTheDocument();
    });
  });

  describe('Tab Switching', () => {
    it('should switch to Source tab when clicked', async () => {
      const user = userEvent.setup();
      render(<MermaidChart chartDefinition={mockChartDefinition} />);

      const chartTab = screen.getByTestId('mermaid-chart-tab');
      const sourceTab = screen.getByTestId('mermaid-source-tab');

      await user.click(sourceTab);

      expect(sourceTab).toHaveAttribute('aria-selected', 'true');
      expect(chartTab).toHaveAttribute('aria-selected', 'false');
    });

    it('should switch back to Chart tab when clicked', async () => {
      const user = userEvent.setup();
      render(<MermaidChart chartDefinition={mockChartDefinition} />);

      const chartTab = screen.getByTestId('mermaid-chart-tab');
      const sourceTab = screen.getByTestId('mermaid-source-tab');

      await user.click(sourceTab);
      await user.click(chartTab);

      expect(chartTab).toHaveAttribute('aria-selected', 'true');
      expect(sourceTab).toHaveAttribute('aria-selected', 'false');
    });

    it('should display source code in Source tab', async () => {
      const user = userEvent.setup();
      render(<MermaidChart chartDefinition={mockChartDefinition} />);

      await user.click(screen.getByTestId('mermaid-source-tab'));

      const sourceDisplay = screen.getByTestId('mermaid-source-readonly');
      expect(sourceDisplay).toBeInTheDocument();
      expect(sourceDisplay.textContent).toContain('graph TD');
      expect(sourceDisplay.textContent).toContain('A-->B');
    });
  });

  describe('Copy Button (ContentCopy) - Context Awareness', () => {
    it('should have "Copy as PNG" tooltip on Chart tab', () => {
      render(<MermaidChart chartDefinition={mockChartDefinition} />);

      const copyButton = screen.getByTestId('mermaid-copy-btn');
      expect(copyButton).toHaveAttribute('title', 'Copy as PNG');
    });

    it('should have "Copy source code" tooltip on Source tab', async () => {
      const user = userEvent.setup();
      render(<MermaidChart chartDefinition={mockChartDefinition} />);

      await user.click(screen.getByTestId('mermaid-source-tab'));

      const copyButton = screen.getByTestId('mermaid-copy-btn');
      expect(copyButton).toHaveAttribute('title', 'Copy source code');
    });

    it('should copy source code text when on Source tab', async () => {
      const user = userEvent.setup();
      render(<MermaidChart chartDefinition={mockChartDefinition} />);

      await user.click(screen.getByTestId('mermaid-source-tab'));

      const copyButton = screen.getByTestId('mermaid-copy-btn');
      await user.click(copyButton);

      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(mockChartDefinition);
      expect(mockShowSnackbar).toHaveBeenCalledWith('Chart definition copied to clipboard', {
        variant: 'plain',
      });
    });

    it('should handle clipboard errors gracefully on Source tab', async () => {
      const user = userEvent.setup();
      vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('Clipboard denied'));

      render(<MermaidChart chartDefinition={mockChartDefinition} />);

      await user.click(screen.getByTestId('mermaid-source-tab'));
      const copyButton = screen.getByTestId('mermaid-copy-btn');
      await user.click(copyButton);

      await waitFor(() => {
        expect(mockShowSnackbar).toHaveBeenCalledWith('Failed to copy chart definition', {
          variant: 'soft',
        });
      });
    });
  });

  describe('Code Button (Copy Definition)', () => {
    it('should copy chart definition when clicked on Chart tab', async () => {
      const user = userEvent.setup();
      render(<MermaidChart chartDefinition={mockChartDefinition} />);

      const codeButton = screen.getByTestId('mermaid-copy-definition-btn');
      await user.click(codeButton);

      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(mockChartDefinition);
      expect(mockShowSnackbar).toHaveBeenCalledWith('Chart definition copied to clipboard', {
        variant: 'plain',
      });
    });

    it('should copy chart definition when clicked on Source tab', async () => {
      const user = userEvent.setup();
      render(<MermaidChart chartDefinition={mockChartDefinition} />);

      await user.click(screen.getByTestId('mermaid-source-tab'));

      const codeButton = screen.getByTestId('mermaid-copy-definition-btn');
      await user.click(codeButton);

      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(mockChartDefinition);
    });

    it('should handle clipboard errors gracefully', async () => {
      const user = userEvent.setup();
      vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('Clipboard denied'));

      render(<MermaidChart chartDefinition={mockChartDefinition} />);

      const codeButton = screen.getByTestId('mermaid-copy-definition-btn');
      await user.click(codeButton);

      await waitFor(() => {
        expect(mockShowSnackbar).toHaveBeenCalledWith('Failed to copy chart definition', {
          variant: 'soft',
        });
      });
    });
  });

  describe('Read-Only vs Editable Mode', () => {
    it('should display source as pre element in read-only mode', async () => {
      const user = userEvent.setup();
      render(<MermaidChart chartDefinition={mockChartDefinition} readOnly={true} />);

      await user.click(screen.getByTestId('mermaid-source-tab'));

      const sourceDisplay = screen.getByTestId('mermaid-source-readonly');
      expect(sourceDisplay.tagName).toBe('PRE');
      expect(sourceDisplay.textContent).toContain('graph TD');
      expect(sourceDisplay.textContent).toContain('A-->B');
    });

    it('should display source as textarea in editable mode', async () => {
      const user = userEvent.setup();
      render(<MermaidChart chartDefinition={mockChartDefinition} readOnly={false} />);

      await user.click(screen.getByTestId('mermaid-source-tab'));

      const textarea = screen.getByTestId('mermaid-source-textarea');
      expect(textarea).toBeInTheDocument();
      expect(textarea).toHaveValue(mockChartDefinition);
    });

    it('should call onChartChange when editing in non-readonly mode', async () => {
      const user = userEvent.setup();
      const mockOnChartChange = vi.fn();
      render(<MermaidChart chartDefinition={mockChartDefinition} readOnly={false} onChartChange={mockOnChartChange} />);

      await user.click(screen.getByTestId('mermaid-source-tab'));

      const textarea = screen.getByTestId('mermaid-source-textarea');
      await user.clear(textarea);
      const newDefinition = 'graph LR\n  X-->Y';
      await user.type(textarea, newDefinition);

      expect(mockOnChartChange).toHaveBeenLastCalledWith(newDefinition);
    });
  });

  describe('Error Handling', () => {
    it('should display error message when chart rendering fails', async () => {
      const mermaid = await import('mermaid');
      vi.mocked(mermaid.default.render).mockRejectedValueOnce(new Error('Syntax error'));

      render(<MermaidChart chartDefinition="invalid mermaid syntax" />);

      await waitFor(() => {
        const errorDisplay = screen.getByTestId('mermaid-error-display');
        expect(errorDisplay).toBeInTheDocument();
        expect(errorDisplay.textContent).toContain('Failed to render chart');
        expect(errorDisplay.textContent).toContain('Syntax error');
      });
    });
  });

  describe('Local Definition Updates', () => {
    it('should update local definition when typing in editable mode', async () => {
      const user = userEvent.setup();
      render(<MermaidChart chartDefinition={mockChartDefinition} readOnly={false} />);

      await user.click(screen.getByTestId('mermaid-source-tab'));

      const textarea = screen.getByTestId('mermaid-source-textarea');
      await user.clear(textarea);
      const newDefinition = 'graph LR\n  X-->Y';
      await user.type(textarea, newDefinition);

      expect(textarea).toHaveValue(newDefinition);
    });

    it('should copy updated local definition, not original prop', async () => {
      const user = userEvent.setup();
      render(<MermaidChart chartDefinition={mockChartDefinition} readOnly={false} />);

      await user.click(screen.getByTestId('mermaid-source-tab'));

      const textarea = screen.getByTestId('mermaid-source-textarea');
      await user.clear(textarea);
      const newDefinition = 'graph LR\n  X-->Y';
      await user.type(textarea, newDefinition);

      expect(textarea).toHaveValue(newDefinition);

      const codeButton = screen.getByTestId('mermaid-copy-definition-btn');
      await user.click(codeButton);

      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(newDefinition);
    });
  });
});
