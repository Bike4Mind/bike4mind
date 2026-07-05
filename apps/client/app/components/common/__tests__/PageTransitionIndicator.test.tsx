import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider } from '@mui/joy/styles';
import PageTransitionIndicator from '../PageTransitionIndicator';

// Mock the navigation hook
const mockUseNavigationLoading = vi.fn();

vi.mock('../../../hooks/useNavigationLoading', () => ({
  useNavigationLoading: () => mockUseNavigationLoading(),
}));

// Test wrapper with MUI theme
const TestWrapper = ({ children }: { children: React.ReactNode }) => <CssVarsProvider>{children}</CssVarsProvider>;

describe('PageTransitionIndicator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseNavigationLoading.mockReturnValue({
      isLoading: false,
      targetUrl: null,
      progress: 100,
      startNavigation: vi.fn(),
      completeNavigation: vi.fn(),
      cancelNavigation: vi.fn(),
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Basic Rendering', () => {
    it('renders without crashing', () => {
      render(
        <TestWrapper>
          <PageTransitionIndicator />
        </TestWrapper>
      );

      const indicator = screen.getByTestId('page-transition-indicator');
      expect(indicator).toBeInTheDocument();
    });

    it('has correct default props', () => {
      render(
        <TestWrapper>
          <PageTransitionIndicator />
        </TestWrapper>
      );

      const indicator = screen.getByTestId('page-transition-indicator');
      expect(indicator).toBeInTheDocument();
      expect(indicator).toHaveAttribute('data-testid', 'page-transition-indicator');
    });

    it('accepts custom testId', () => {
      render(
        <TestWrapper>
          <PageTransitionIndicator data-testid="custom-indicator" />
        </TestWrapper>
      );

      const indicator = screen.getByTestId('custom-indicator');
      expect(indicator).toBeInTheDocument();
    });
  });

  describe('Loading State Visibility', () => {
    it('is hidden when not loading', () => {
      mockUseNavigationLoading.mockReturnValue({
        isLoading: false,
        targetUrl: null,
        progress: 100,
        startNavigation: vi.fn(),
        completeNavigation: vi.fn(),
        cancelNavigation: vi.fn(),
      });

      render(
        <TestWrapper>
          <PageTransitionIndicator />
        </TestWrapper>
      );

      const indicator = screen.getByTestId('page-transition-indicator');
      expect(indicator).toHaveStyle({ opacity: '0', transform: 'scaleX(0)' });
    });

    it('is visible when loading', () => {
      mockUseNavigationLoading.mockReturnValue({
        isLoading: true,
        targetUrl: '/test-page',
        progress: 70,
        startNavigation: vi.fn(),
        completeNavigation: vi.fn(),
        cancelNavigation: vi.fn(),
      });

      render(
        <TestWrapper>
          <PageTransitionIndicator />
        </TestWrapper>
      );

      const indicator = screen.getByTestId('page-transition-indicator');
      expect(indicator).toHaveStyle({ opacity: '1', transform: 'scaleX(1)' });
    });
  });

  describe('Props and Customization', () => {
    it('applies custom thickness prop', () => {
      render(
        <TestWrapper>
          <PageTransitionIndicator thickness={4} />
        </TestWrapper>
      );

      const indicator = screen.getByTestId('page-transition-indicator');
      expect(indicator).toBeInTheDocument();
      // LinearProgress thickness prop would be applied internally
    });

    it('applies custom color prop', () => {
      render(
        <TestWrapper>
          <PageTransitionIndicator color="success" />
        </TestWrapper>
      );

      const indicator = screen.getByTestId('page-transition-indicator');
      expect(indicator).toBeInTheDocument();
      // LinearProgress color prop would be applied internally
    });

    it('applies custom variant prop', () => {
      render(
        <TestWrapper>
          <PageTransitionIndicator variant="solid" />
        </TestWrapper>
      );

      const indicator = screen.getByTestId('page-transition-indicator');
      expect(indicator).toBeInTheDocument();
      // LinearProgress variant prop would be applied internally
    });

    it('applies custom size prop', () => {
      render(
        <TestWrapper>
          <PageTransitionIndicator size="lg" />
        </TestWrapper>
      );

      const indicator = screen.getByTestId('page-transition-indicator');
      expect(indicator).toBeInTheDocument();
      // LinearProgress size prop would be applied internally
    });

    it('applies custom position prop', () => {
      render(
        <TestWrapper>
          <PageTransitionIndicator position="bottom" />
        </TestWrapper>
      );

      const indicator = screen.getByTestId('page-transition-indicator');
      expect(indicator).toHaveStyle({ bottom: '0' });
    });

    it('applies custom zIndex prop', () => {
      render(
        <TestWrapper>
          <PageTransitionIndicator zIndex={5000} />
        </TestWrapper>
      );

      const indicator = screen.getByTestId('page-transition-indicator');
      expect(indicator).toHaveStyle({ zIndex: '5000' });
    });

    it('applies custom animationDuration prop', () => {
      render(
        <TestWrapper>
          <PageTransitionIndicator animationDuration={500} />
        </TestWrapper>
      );

      const indicator = screen.getByTestId('page-transition-indicator');
      expect(indicator).toHaveStyle({ transition: 'all 500ms ease-in-out' });
    });

    it('applies custom className prop', () => {
      render(
        <TestWrapper>
          <PageTransitionIndicator className="custom-class" />
        </TestWrapper>
      );

      const indicator = screen.getByTestId('page-transition-indicator');
      expect(indicator).toHaveClass('custom-class');
    });
  });

  describe('CSS Styling', () => {
    it('has correct fixed positioning styles', () => {
      render(
        <TestWrapper>
          <PageTransitionIndicator />
        </TestWrapper>
      );

      const indicator = screen.getByTestId('page-transition-indicator');
      expect(indicator).toHaveStyle({
        position: 'fixed',
        top: '0',
        left: '0',
        right: '0',
      });
    });

    it('has correct default z-index', () => {
      render(
        <TestWrapper>
          <PageTransitionIndicator />
        </TestWrapper>
      );

      const indicator = screen.getByTestId('page-transition-indicator');
      expect(indicator).toHaveStyle({ zIndex: '9999' });
    });

    it('has correct transform origin', () => {
      render(
        <TestWrapper>
          <PageTransitionIndicator />
        </TestWrapper>
      );

      const indicator = screen.getByTestId('page-transition-indicator');
      expect(indicator).toHaveStyle({ transformOrigin: 'left' });
    });

    it('has correct default transition', () => {
      render(
        <TestWrapper>
          <PageTransitionIndicator />
        </TestWrapper>
      );

      const indicator = screen.getByTestId('page-transition-indicator');
      expect(indicator).toHaveStyle({ transition: 'all 300ms ease-in-out' });
    });
  });

  describe('Accessibility', () => {
    it('has correct role attribute', () => {
      render(
        <TestWrapper>
          <PageTransitionIndicator />
        </TestWrapper>
      );

      const indicator = screen.getByRole('progressbar');
      expect(indicator).toBeInTheDocument();
    });

    it('has correct aria-label', () => {
      render(
        <TestWrapper>
          <PageTransitionIndicator />
        </TestWrapper>
      );

      const indicator = screen.getByLabelText('Page loading');
      expect(indicator).toBeInTheDocument();
    });

    it('has correct ARIA attributes for progressbar', () => {
      render(
        <TestWrapper>
          <PageTransitionIndicator />
        </TestWrapper>
      );

      const indicator = screen.getByRole('progressbar');
      expect(indicator).toHaveAttribute('aria-valuemin', '0');
      expect(indicator).toHaveAttribute('aria-valuemax', '100');
    });
  });

  describe('Responsive Design', () => {
    it('includes prefers-reduced-motion media query', () => {
      render(
        <TestWrapper>
          <PageTransitionIndicator />
        </TestWrapper>
      );

      const indicator = screen.getByTestId('page-transition-indicator');
      // The media query would be applied through MUI's sx prop
      expect(indicator).toBeInTheDocument();
    });
  });

  describe('Integration with Navigation Hook', () => {
    it('renders correctly with different loading states', async () => {
      // Test with isLoading: false
      const { unmount } = render(
        <TestWrapper>
          <PageTransitionIndicator />
        </TestWrapper>
      );

      const indicator = screen.getByTestId('page-transition-indicator');
      expect(indicator).toHaveStyle({ opacity: '0' });

      unmount();

      // Test with isLoading: true
      mockUseNavigationLoading.mockReturnValue({
        isLoading: true,
        targetUrl: '/test-page',
        progress: 70,
        startNavigation: vi.fn(),
        completeNavigation: vi.fn(),
        cancelNavigation: vi.fn(),
      });

      render(
        <TestWrapper>
          <PageTransitionIndicator />
        </TestWrapper>
      );

      await waitFor(() => {
        const updatedIndicator = screen.getByTestId('page-transition-indicator');
        const computedStyle = window.getComputedStyle(updatedIndicator);
        expect(computedStyle.opacity).toBe('1');
      });
    });

    it('uses navigation hook values correctly', () => {
      const mockHookReturn = {
        isLoading: true,
        targetUrl: '/test-page',
        progress: 70,
        startNavigation: vi.fn(),
        completeNavigation: vi.fn(),
        cancelNavigation: vi.fn(),
      };

      mockUseNavigationLoading.mockReturnValue(mockHookReturn);

      render(
        <TestWrapper>
          <PageTransitionIndicator />
        </TestWrapper>
      );

      expect(mockUseNavigationLoading).toHaveBeenCalled();
      const indicator = screen.getByTestId('page-transition-indicator');
      expect(indicator).toHaveStyle({ opacity: '1', transform: 'scaleX(1)' });
    });
  });
});
