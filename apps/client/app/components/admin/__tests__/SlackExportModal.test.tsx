import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

/**
 * Tests for the Slack export modal: date range presets, export flow, and error handling.
 */

// Use vi.hoisted to define mocks that can be used in vi.mock factories
const { mockGet, mockPost, mockSuccess, mockError, mockWarning } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockSuccess: vi.fn(),
  mockError: vi.fn(),
  mockWarning: vi.fn(),
}));

// Mock the API context
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: {
    get: mockGet,
    post: mockPost,
  },
}));

// Mock sonner toast
vi.mock('sonner', () => ({
  toast: {
    success: mockSuccess,
    error: mockError,
    warning: mockWarning,
  },
}));

// Mock the branding settings hook to avoid cascading dependency issues
vi.mock('@client/app/hooks/data/settings', () => ({
  useBrandingSettings: () => ({
    data: { appLogo: '/test-logo.png', appName: 'Test App' },
    isLoading: false,
    error: null,
  }),
}));

// Mock EventMetrics component to avoid complex data fetching and rendering in tests
vi.mock('../EventMetrics', () => ({
  default: () => <div data-testid="mock-event-metrics">Event Metrics Dashboard</div>,
}));

// Import component after mocks
import SlackWorkspacesTab from '../SlackWorkspacesTab';

// The admin toolkit reads the admin palette tokens, which only the app theme defines.
const appTheme = extendTheme({ ...getThemeConfig() });

// Helper to create a wrapper with QueryClient
const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  const TestWrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
    </QueryClientProvider>
  );
  TestWrapper.displayName = 'TestWrapper';
  return TestWrapper;
};

// Convenience references for tests
const mockApi = { get: mockGet, post: mockPost };
const mockToast = { success: mockSuccess, error: mockError, warning: mockWarning };

describe('SlackWorkspacesTab Export Modal', () => {
  const mockWorkspaces = [
    {
      id: 'ws-123',
      name: 'Test Workspace',
      slackTeamId: 'T123456',
      slackBotName: 'TestBot',
      slackAppId: 'A123456',
      isActive: true,
      installedAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.get.mockResolvedValue({ data: { workspaces: mockWorkspaces } });
  });

  // Only this file's mocks: resetting every mock would also wipe the setup file's matchMedia,
  // which the theme provider reads.
  afterEach(() => {
    [mockGet, mockPost, mockSuccess, mockError, mockWarning].forEach(mock => mock.mockReset());
  });

  describe('Date Range Presets', () => {
    it('should display date range preset buttons in export modal', async () => {
      render(<SlackWorkspacesTab />, { wrapper: createWrapper() });

      // Wait for workspaces to load
      await waitFor(() => {
        expect(screen.getByText('Test Workspace')).toBeInTheDocument();
      });

      // Click export button
      fireEvent.click(screen.getByTestId('slack-workspace-menu-btn-T123456'));
      fireEvent.click(await screen.findByTestId('slack-workspace-export-btn-T123456'));

      // Check preset buttons are visible
      expect(screen.getByText('Last 7 days')).toBeInTheDocument();
      expect(screen.getByText('Last 30 days')).toBeInTheDocument();
      expect(screen.getByText('This month')).toBeInTheDocument();
      expect(screen.getByText('Last month')).toBeInTheDocument();
      expect(screen.getByText('All time')).toBeInTheDocument();
    });
  });

  describe('Export Flow', () => {
    it('should show success toast on successful export', async () => {
      // Mock successful export
      const mockBlob = new Blob([JSON.stringify({ messages: [], export_status: 'complete' })], {
        type: 'application/json',
      });
      mockApi.post.mockResolvedValue({
        data: mockBlob,
        headers: {
          'content-disposition': 'attachment; filename="slack-test-2024-01-01.json"',
        },
      });

      // Mock URL.createObjectURL
      const mockUrl = 'blob:test-url';
      global.URL.createObjectURL = vi.fn(() => mockUrl);
      global.URL.revokeObjectURL = vi.fn();

      render(<SlackWorkspacesTab />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText('Test Workspace')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('slack-workspace-menu-btn-T123456'));
      fireEvent.click(await screen.findByTestId('slack-workspace-export-btn-T123456'));

      // Enter channel ID
      fireEvent.change(screen.getByTestId('slack-export-channel-id-input'), { target: { value: 'C12345678' } });

      // Click export
      fireEvent.click(screen.getByTestId('slack-export-confirm-btn'));

      await waitFor(() => {
        expect(mockToast.success).toHaveBeenCalledWith('Channel exported successfully!');
      });
    });

    it('should show warning toast on partial export', async () => {
      // Mock partial export response
      const mockBlob = new Blob([JSON.stringify({ messages: [{ ts: '1' }], export_status: 'partial' })], {
        type: 'application/json',
      });
      mockApi.post.mockResolvedValue({
        data: mockBlob,
        headers: {
          'content-disposition': 'attachment; filename="slack-test-2024-01-01-partial.json"',
          'x-export-status': 'partial',
          'x-export-warning-count': '2',
        },
      });

      global.URL.createObjectURL = vi.fn(() => 'blob:test-url');
      global.URL.revokeObjectURL = vi.fn();

      render(<SlackWorkspacesTab />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText('Test Workspace')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('slack-workspace-menu-btn-T123456'));
      fireEvent.click(await screen.findByTestId('slack-workspace-export-btn-T123456'));

      fireEvent.change(screen.getByTestId('slack-export-channel-id-input'), { target: { value: 'C12345678' } });

      fireEvent.click(screen.getByTestId('slack-export-confirm-btn'));

      await waitFor(() => {
        expect(mockToast.warning).toHaveBeenCalledWith(
          expect.stringContaining('Partial export completed'),
          expect.any(Object)
        );
      });
    });

    it('should show error toast with suggestion on failure', async () => {
      // Mock error response
      const errorBlob = new Blob(
        [
          JSON.stringify({
            message: 'Channel not found',
            error: {
              suggestion: 'Invite the bot to the channel first',
            },
          }),
        ],
        { type: 'application/json' }
      );

      mockApi.post.mockRejectedValue({
        response: {
          data: errorBlob,
        },
      });

      render(<SlackWorkspacesTab />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText('Test Workspace')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('slack-workspace-menu-btn-T123456'));
      fireEvent.click(await screen.findByTestId('slack-workspace-export-btn-T123456'));

      fireEvent.change(screen.getByTestId('slack-export-channel-id-input'), { target: { value: 'C12345678' } });

      fireEvent.click(screen.getByTestId('slack-export-confirm-btn'));

      await waitFor(() => {
        expect(mockToast.error).toHaveBeenCalled();
      });
    });

    it('should enable the export button only once a channel ID is entered', async () => {
      render(<SlackWorkspacesTab />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText('Test Workspace')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('slack-workspace-menu-btn-T123456'));
      fireEvent.click(await screen.findByTestId('slack-workspace-export-btn-T123456'));

      const confirmBtn = screen.getByTestId('slack-export-confirm-btn');
      expect(confirmBtn).toBeDisabled();

      fireEvent.change(screen.getByTestId('slack-export-channel-id-input'), { target: { value: 'C12345678' } });

      expect(confirmBtn).not.toBeDisabled();
    });
  });

  describe('Modal State Management', () => {
    it('should show loading state during export', async () => {
      // Make the API call hang
      mockApi.post.mockImplementation(() => new Promise(() => {}));

      render(<SlackWorkspacesTab />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText('Test Workspace')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('slack-workspace-menu-btn-T123456'));
      fireEvent.click(await screen.findByTestId('slack-workspace-export-btn-T123456'));

      fireEvent.change(screen.getByTestId('slack-export-channel-id-input'), { target: { value: 'C12345678' } });

      fireEvent.click(screen.getByTestId('slack-export-confirm-btn'));

      // Should show loading indicator
      await waitFor(() => {
        expect(screen.getByText(/Exporting channel/i)).toBeInTheDocument();
      });
    });
  });
});
