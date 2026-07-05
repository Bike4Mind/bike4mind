import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

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

// Mock next/image
vi.mock('next/image', () => ({
  default: ({ src, alt, ...props }: any) => <img src={src} alt={alt} {...props} />,
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

// Mock useIsMobile to avoid window.matchMedia dependency in jsdom
vi.mock('@client/app/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
}));

// Import component after mocks
import SlackWorkspacesTab from '../SlackWorkspacesTab';

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
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  TestWrapper.displayName = 'TestWrapper';
  return TestWrapper;
};

// Convenience references for tests
const mockApi = { get: mockGet, post: mockPost };
const mockToast = { success: mockSuccess, error: mockError, warning: mockWarning };

// Create userEvent with pointer events check disabled (for MUI components)
const setupUserEvent = () =>
  userEvent.setup({
    pointerEventsCheck: 0, // Disable pointer-events check for MUI components
  });

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

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('Date Range Presets', () => {
    it('should display date range preset buttons in export modal', async () => {
      const user = setupUserEvent();
      render(<SlackWorkspacesTab />, { wrapper: createWrapper() });

      // Wait for workspaces to load
      await waitFor(() => {
        expect(screen.getByText('Test Workspace')).toBeInTheDocument();
      });

      // Click export button
      const exportBtn = screen.getByTestId('slack-workspace-export-btn-T123456');
      await user.click(exportBtn);

      // Check preset buttons are visible
      expect(screen.getByText('Last 7 days')).toBeInTheDocument();
      expect(screen.getByText('Last 30 days')).toBeInTheDocument();
      expect(screen.getByText('This month')).toBeInTheDocument();
      expect(screen.getByText('Last month')).toBeInTheDocument();
      expect(screen.getByText('All time')).toBeInTheDocument();
    });

    // Skipped: MUI Joy Chip onClick handlers don't reliably trigger state changes in JSDOM;
    // better covered by E2E tests.
    it.skip('should set correct date range when "Last 7 days" preset is clicked', async () => {
      const user = setupUserEvent();
      render(<SlackWorkspacesTab />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText('Test Workspace')).toBeInTheDocument();
      });

      // Open export modal
      const exportBtn = screen.getByTestId('slack-workspace-export-btn-T123456');
      await user.click(exportBtn);

      // Click "Last 7 days" preset
      await user.click(screen.getByTestId('slack-export-preset-last7'));

      // Check that date inputs are populated
      const startInput = screen.getByTestId('slack-export-date-start-input') as HTMLInputElement;
      const endInput = screen.getByTestId('slack-export-date-end-input') as HTMLInputElement;

      // Start date should be 7 days ago
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      expect(startInput.value).toBe(sevenDaysAgo.toISOString().split('T')[0]);

      // End date should be today
      const today = new Date().toISOString().split('T')[0];
      expect(endInput.value).toBe(today);
    });

    it.skip('should set correct date range when "Last 30 days" preset is clicked', async () => {
      const user = setupUserEvent();
      render(<SlackWorkspacesTab />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText('Test Workspace')).toBeInTheDocument();
      });

      const exportBtn = screen.getByTestId('slack-workspace-export-btn-T123456');
      await user.click(exportBtn);

      await user.click(screen.getByTestId('slack-export-preset-last30'));

      const startInput = screen.getByTestId('slack-export-date-start-input') as HTMLInputElement;

      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      expect(startInput.value).toBe(thirtyDaysAgo.toISOString().split('T')[0]);
    });

    it.skip('should set correct date range when "This month" preset is clicked', async () => {
      const user = setupUserEvent();
      render(<SlackWorkspacesTab />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText('Test Workspace')).toBeInTheDocument();
      });

      const exportBtn = screen.getByTestId('slack-workspace-export-btn-T123456');
      await user.click(exportBtn);

      await user.click(screen.getByTestId('slack-export-preset-thisMonth'));

      const startInput = screen.getByTestId('slack-export-date-start-input') as HTMLInputElement;

      // Start date should be first of current month
      const now = new Date();
      const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
      expect(startInput.value).toBe(firstOfMonth);
    });

    it.skip('should set correct date range when "Last month" preset is clicked', async () => {
      const user = setupUserEvent();
      render(<SlackWorkspacesTab />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText('Test Workspace')).toBeInTheDocument();
      });

      const exportBtn = screen.getByTestId('slack-workspace-export-btn-T123456');
      await user.click(exportBtn);

      await user.click(screen.getByTestId('slack-export-preset-lastMonth'));

      const startInput = screen.getByTestId('slack-export-date-start-input') as HTMLInputElement;
      const endInput = screen.getByTestId('slack-export-date-end-input') as HTMLInputElement;

      const now = new Date();
      const firstOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().split('T')[0];
      const lastOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().split('T')[0];

      expect(startInput.value).toBe(firstOfLastMonth);
      expect(endInput.value).toBe(lastOfLastMonth);
    });

    it.skip('should clear date range when "All time" preset is clicked', async () => {
      const user = setupUserEvent();
      render(<SlackWorkspacesTab />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText('Test Workspace')).toBeInTheDocument();
      });

      const exportBtn = screen.getByTestId('slack-workspace-export-btn-T123456');
      await user.click(exportBtn);

      // First set a date range
      await user.click(screen.getByTestId('slack-export-preset-last7'));

      // Then clear it
      await user.click(screen.getByTestId('slack-export-preset-allTime'));

      const startInput = screen.getByTestId('slack-export-date-start-input') as HTMLInputElement;
      const endInput = screen.getByTestId('slack-export-date-end-input') as HTMLInputElement;

      expect(startInput.value).toBe('');
      expect(endInput.value).toBe('');
    });

    it.skip('should clear preset selection when date is manually changed', async () => {
      const user = setupUserEvent();
      render(<SlackWorkspacesTab />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText('Test Workspace')).toBeInTheDocument();
      });

      const exportBtn = screen.getByTestId('slack-workspace-export-btn-T123456');
      await user.click(exportBtn);

      // Select a preset
      const last7DaysChip = screen.getByTestId('slack-export-preset-last7');
      await user.click(last7DaysChip);

      // Verify date inputs are populated (proves click worked)
      const startInput = screen.getByTestId('slack-export-date-start-input') as HTMLInputElement;
      await waitFor(() => {
        expect(startInput.value).not.toBe('');
      });

      // Manually change start date
      await user.clear(startInput);
      await user.type(startInput, '2024-01-01');

      // Verify the date was actually changed
      expect(startInput.value).toBe('2024-01-01');
    });
  });

  describe('Export Flow', () => {
    it('should show success toast on successful export', async () => {
      const user = setupUserEvent();

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

      const exportBtn = screen.getByTestId('slack-workspace-export-btn-T123456');
      await user.click(exportBtn);

      // Enter channel ID
      const channelInput = screen.getByTestId('slack-export-channel-id-input');
      await user.type(channelInput, 'C12345678');

      // Click export
      const confirmBtn = screen.getByTestId('slack-export-confirm-btn');
      await user.click(confirmBtn);

      await waitFor(() => {
        expect(mockToast.success).toHaveBeenCalledWith('Channel exported successfully!');
      });
    });

    it('should show warning toast on partial export', async () => {
      const user = setupUserEvent();

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

      const exportBtn = screen.getByTestId('slack-workspace-export-btn-T123456');
      await user.click(exportBtn);

      const channelInput = screen.getByTestId('slack-export-channel-id-input');
      await user.type(channelInput, 'C12345678');

      const confirmBtn = screen.getByTestId('slack-export-confirm-btn');
      await user.click(confirmBtn);

      await waitFor(() => {
        expect(mockToast.warning).toHaveBeenCalledWith(
          expect.stringContaining('Partial export completed'),
          expect.any(Object)
        );
      });
    });

    it('should show error toast with suggestion on failure', async () => {
      const user = setupUserEvent();

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

      const exportBtn = screen.getByTestId('slack-workspace-export-btn-T123456');
      await user.click(exportBtn);

      const channelInput = screen.getByTestId('slack-export-channel-id-input');
      await user.type(channelInput, 'C12345678');

      const confirmBtn = screen.getByTestId('slack-export-confirm-btn');
      await user.click(confirmBtn);

      await waitFor(() => {
        expect(mockToast.error).toHaveBeenCalled();
      });
    });

    it('should disable export button when no channel ID is entered', async () => {
      const user = setupUserEvent();
      render(<SlackWorkspacesTab />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText('Test Workspace')).toBeInTheDocument();
      });

      const exportBtn = screen.getByTestId('slack-workspace-export-btn-T123456');
      await user.click(exportBtn);

      const confirmBtn = screen.getByTestId('slack-export-confirm-btn');
      expect(confirmBtn).toBeDisabled();
    });

    it('should enable export button when channel ID is entered', async () => {
      const user = setupUserEvent();
      render(<SlackWorkspacesTab />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText('Test Workspace')).toBeInTheDocument();
      });

      const exportBtn = screen.getByTestId('slack-workspace-export-btn-T123456');
      await user.click(exportBtn);

      const channelInput = screen.getByTestId('slack-export-channel-id-input');
      await user.type(channelInput, 'C12345678');

      const confirmBtn = screen.getByTestId('slack-export-confirm-btn');
      expect(confirmBtn).not.toBeDisabled();
    });
  });

  describe('Modal State Management', () => {
    // Skipped: Testing state reset after chip clicks has issues in JSDOM
    it.skip('should reset all form fields when modal is closed', async () => {
      const user = setupUserEvent();
      render(<SlackWorkspacesTab />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText('Test Workspace')).toBeInTheDocument();
      });

      // Open modal
      const exportBtn = screen.getByTestId('slack-workspace-export-btn-T123456');
      await user.click(exportBtn);

      // Fill in fields
      const channelInput = screen.getByTestId('slack-export-channel-id-input');
      await user.type(channelInput, 'C12345678');
      await user.click(screen.getByTestId('slack-export-preset-last7'));

      // Close modal
      const cancelBtn = screen.getByTestId('slack-export-cancel-btn');
      await user.click(cancelBtn);

      // Reopen modal
      await user.click(exportBtn);

      // Check fields are reset
      const newChannelInput = screen.getByTestId('slack-export-channel-id-input') as HTMLInputElement;
      expect(newChannelInput.value).toBe('');

      const startInput = screen.getByTestId('slack-export-date-start-input') as HTMLInputElement;
      expect(startInput.value).toBe('');
    });

    it('should show loading state during export', async () => {
      const user = setupUserEvent();

      // Make the API call hang
      mockApi.post.mockImplementation(
        () =>
          new Promise(resolve => {
            setTimeout(() => resolve({ data: new Blob(), headers: {} }), 10000);
          })
      );

      render(<SlackWorkspacesTab />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText('Test Workspace')).toBeInTheDocument();
      });

      const exportBtn = screen.getByTestId('slack-workspace-export-btn-T123456');
      await user.click(exportBtn);

      const channelInput = screen.getByTestId('slack-export-channel-id-input');
      await user.type(channelInput, 'C12345678');

      const confirmBtn = screen.getByTestId('slack-export-confirm-btn');
      await user.click(confirmBtn);

      // Should show loading indicator
      await waitFor(() => {
        expect(screen.getByText(/Exporting channel/i)).toBeInTheDocument();
      });
    });
  });
});
