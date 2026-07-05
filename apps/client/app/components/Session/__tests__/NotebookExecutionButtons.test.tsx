import { describe, it, expect, vi, beforeEach, afterEach, Mock } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { AxiosError, AxiosHeaders } from 'axios';
import { NotebookExecutionButtons } from '../NotebookExecutionButtons';

// Mock dependencies - use vi.hoisted() to ensure these are defined before vi.mock hoisting
const { mockSubscribeToAction, mockPost } = vi.hoisted(() => ({
  mockSubscribeToAction: vi.fn(),
  mockPost: vi.fn(),
}));

vi.mock('@client/app/contexts/WebsocketContext', () => ({
  useWebsocket: () => ({
    subscribeToAction: mockSubscribeToAction,
  }),
}));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: {
    post: mockPost,
  },
}));

describe('NotebookExecutionButtons', () => {
  const validNotebookContent = JSON.stringify({
    nbformat: 4,
    cells: [{ cell_type: 'code', source: 'print("hello")' }],
  });

  let unsubscribeMock: Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    unsubscribeMock = vi.fn();
    mockSubscribeToAction.mockReturnValue(unsubscribeMock);
    sessionStorage.clear();
  });

  afterEach(() => {
    sessionStorage.clear();
  });

  describe('rendering', () => {
    it('renders nothing when notebookContent is not provided', () => {
      const { container } = render(<NotebookExecutionButtons sessionId="s1" messageId="m1" />);
      expect(container).toBeEmptyDOMElement();
    });

    it('renders execute button when notebook content is provided', () => {
      render(<NotebookExecutionButtons notebookContent={validNotebookContent} sessionId="s1" messageId="m1" />);
      expect(screen.getByTestId('notebook-execute-btn')).toBeInTheDocument();
      expect(screen.getByText('Execute Locally')).toBeInTheDocument();
      expect(screen.getByText('Run this notebook locally with Jupyter')).toBeInTheDocument();
    });

    it('shows completed state when status is completed', () => {
      render(
        <NotebookExecutionButtons
          notebookContent={validNotebookContent}
          sessionId="s1"
          messageId="m1"
          jupyterNotebook={{
            status: 'completed',
            cellCount: 5,
            executedCells: 5,
          }}
        />
      );
      expect(screen.getByText(/Notebook executed successfully/)).toBeInTheDocument();
      expect(screen.getByText(/5\/5 cells/)).toBeInTheDocument();
    });

    it('shows failed state when status is failed', () => {
      render(
        <NotebookExecutionButtons
          notebookContent={validNotebookContent}
          sessionId="s1"
          messageId="m1"
          jupyterNotebook={{
            status: 'failed',
            lastError: 'Kernel crashed',
          }}
        />
      );
      expect(screen.getByText(/Notebook execution failed/)).toBeInTheDocument();
      expect(screen.getByText(/Kernel crashed/)).toBeInTheDocument();
      expect(screen.getByText('Retry Execution')).toBeInTheDocument();
    });

    it('shows executing state with progress', () => {
      render(
        <NotebookExecutionButtons
          notebookContent={validNotebookContent}
          sessionId="s1"
          messageId="m1"
          jupyterNotebook={{
            status: 'executing',
            cellCount: 10,
            executedCells: 3,
          }}
        />
      );
      expect(screen.getByText(/Executing notebook/)).toBeInTheDocument();
      expect(screen.getByText(/3\/10 cells, 30%/)).toBeInTheDocument();
    });
  });

  describe('execute button interaction', () => {
    it('calls API with correct parameters when execute button is clicked', async () => {
      mockPost.mockResolvedValue({ data: { sent: true, requestId: 'req-123' } });

      render(
        <NotebookExecutionButtons
          notebookContent={validNotebookContent}
          sessionId="session-123"
          messageId="quest-456"
        />
      );

      const executeBtn = screen.getByTestId('notebook-execute-btn');
      fireEvent.click(executeBtn);

      await waitFor(() => {
        expect(mockPost).toHaveBeenCalledWith('/api/jupyter/execute', {
          notebookJson: validNotebookContent,
          sessionId: 'session-123',
          questId: 'quest-456',
          kernelName: 'python3',
        });
      });
    });

    it('shows error message when API call fails', async () => {
      // Create a proper AxiosError to test isAxiosError() function correctly
      const axiosError = new AxiosError('Request failed', 'ERR_BAD_REQUEST', undefined, undefined, {
        data: {
          error: 'No CLI connections available',
          hint: 'Start the B4M CLI',
        },
        status: 503,
        statusText: 'Service Unavailable',
        headers: new AxiosHeaders(),
        config: { headers: new AxiosHeaders() },
      });
      mockPost.mockRejectedValue(axiosError);

      render(
        <NotebookExecutionButtons
          notebookContent={validNotebookContent}
          sessionId="session-123"
          messageId="quest-456"
        />
      );

      const executeBtn = screen.getByTestId('notebook-execute-btn');
      fireEvent.click(executeBtn);

      await waitFor(() => {
        expect(screen.getByText(/No CLI connections available/)).toBeInTheDocument();
      });
    });

    it('disables button while executing', async () => {
      // Create a promise that we can control
      let resolvePost: (value: unknown) => void;
      const postPromise = new Promise(resolve => {
        resolvePost = resolve;
      });
      mockPost.mockReturnValue(postPromise);

      render(
        <NotebookExecutionButtons
          notebookContent={validNotebookContent}
          sessionId="session-123"
          messageId="quest-456"
        />
      );

      const executeBtn = screen.getByTestId('notebook-execute-btn');
      fireEvent.click(executeBtn);

      // Button should show loading state
      await waitFor(() => {
        expect(screen.getByText('Starting...')).toBeInTheDocument();
      });

      resolvePost!({ data: { sent: true } });
    });
  });

  describe('WebSocket subscription', () => {
    it('subscribes to jupyter_notebook_progress on mount', () => {
      render(<NotebookExecutionButtons notebookContent={validNotebookContent} sessionId="s1" messageId="m1" />);

      expect(mockSubscribeToAction).toHaveBeenCalledWith('jupyter_notebook_progress', expect.any(Function));
    });

    it('unsubscribes on unmount', () => {
      const { unmount } = render(
        <NotebookExecutionButtons notebookContent={validNotebookContent} sessionId="s1" messageId="m1" />
      );

      unmount();
      expect(unsubscribeMock).toHaveBeenCalled();
    });

    it('updates UI when progress message is received', async () => {
      let progressHandler: ((msg: unknown) => Promise<void>) | null = null;
      mockSubscribeToAction.mockImplementation((action: string, handler: (msg: unknown) => Promise<void>) => {
        if (action === 'jupyter_notebook_progress') {
          progressHandler = handler;
        }
        return unsubscribeMock;
      });

      render(
        <NotebookExecutionButtons
          notebookContent={validNotebookContent}
          sessionId="session-123"
          messageId="quest-123"
        />
      );

      // Simulate progress update
      if (progressHandler) {
        await progressHandler({
          action: 'jupyter_notebook_progress',
          questId: 'quest-123',
          sessionId: 'session-123',
          status: 'executing',
          cellIndex: 2,
          totalCells: 5,
        });
      }

      await waitFor(() => {
        expect(screen.getByText(/Executing notebook/)).toBeInTheDocument();
      });
    });
  });

  describe('sessionStorage persistence', () => {
    it('restores started state from sessionStorage', () => {
      sessionStorage.setItem('notebook-exec-quest-123', JSON.stringify({ started: true }));

      render(<NotebookExecutionButtons notebookContent={validNotebookContent} sessionId="s1" messageId="quest-123" />);

      // Should show executing state from persisted data
      expect(screen.getByText(/Executing notebook/)).toBeInTheDocument();
    });

    it('restores error state from sessionStorage', () => {
      sessionStorage.setItem('notebook-exec-quest-123', JSON.stringify({ error: 'Previous error' }));

      render(<NotebookExecutionButtons notebookContent={validNotebookContent} sessionId="s1" messageId="quest-123" />);

      expect(screen.getByText('Previous error')).toBeInTheDocument();
    });

    it('handles corrupted sessionStorage data gracefully', () => {
      sessionStorage.setItem('notebook-exec-quest-123', 'not valid json');

      // Should not throw, should render normally
      render(<NotebookExecutionButtons notebookContent={validNotebookContent} sessionId="s1" messageId="quest-123" />);

      expect(screen.getByTestId('notebook-execute-btn')).toBeInTheDocument();
    });

    it('saves state to sessionStorage on successful execution', async () => {
      mockPost.mockResolvedValue({ data: { sent: true } });

      render(<NotebookExecutionButtons notebookContent={validNotebookContent} sessionId="s1" messageId="quest-123" />);

      const executeBtn = screen.getByTestId('notebook-execute-btn');
      fireEvent.click(executeBtn);

      await waitFor(() => {
        const stored = sessionStorage.getItem('notebook-exec-quest-123');
        expect(stored).toBe(JSON.stringify({ started: true }));
      });
    });
  });
});
