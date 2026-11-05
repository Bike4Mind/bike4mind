import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import TagModal from './TagModal';
import type { CombinedSessionDocument } from './types';

const { mockPost, mockStartJob, mockToast } = vi.hoisted(() => ({
  mockPost: vi.fn(),
  mockStartJob: vi.fn(),
  mockToast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: (...a: unknown[]) => mockPost(...a) } }));
vi.mock('@client/app/hooks/useJobStatus', () => ({ useJobStatus: () => ({ startJob: mockStartJob }) }));
vi.mock('sonner', () => ({ toast: mockToast }));

const appTheme = extendTheme({ ...getThemeConfig() });
const ids = Array.from({ length: 10 }, (_, i) => `s${i}`);
const sessions = ids.map(id => ({ id, name: id, tags: [] })) as unknown as CombinedSessionDocument[];

function renderModal(selected: string[] = ids) {
  const onTagged = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CssVarsProvider theme={appTheme}>
        <TagModal
          open
          onClose={vi.fn()}
          selectedItems={new Set(selected)}
          combinedSessions={sessions}
          onTagged={onTagged}
        />
      </CssVarsProvider>
    </QueryClientProvider>
  );
  return { onTagged };
}

const okFor = (sessionIds: string[]) => ({
  data: { okCount: sessionIds.length, results: sessionIds.map(id => ({ id, ok: true })) },
});

describe('TagModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPost.mockImplementation(async (_url: string, body: { sessionIds: string[] }) => okFor(body.sessionIds));
  });

  it('adds manual tags to 10 sessions in one request', async () => {
    const { onTagged } = renderModal();
    const input = screen.getByPlaceholderText('Type a tag and press Enter...');
    fireEvent.change(input, { target: { value: 'research' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(screen.getByTestId('tag-modal-apply-btn'));

    await waitFor(() => expect(onTagged).toHaveBeenCalled());
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost).toHaveBeenCalledWith('/api/sessions/bulk', {
      action: 'addTags',
      sessionIds: ids,
      tags: ['research'],
    });
    expect(mockStartJob).not.toHaveBeenCalled();
  });

  it('generates tags for 10 sessions in one request and tracks each accepted job', async () => {
    const { onTagged } = renderModal();
    fireEvent.click(screen.getByTestId('tag-modal-apply-btn'));

    await waitFor(() => expect(onTagged).toHaveBeenCalled());
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost).toHaveBeenCalledWith('/api/sessions/bulk', { action: 'generateTags', sessionIds: ids });
    expect(mockPost.mock.calls[0][0]).not.toContain('/tags/generate');
    expect(mockStartJob).toHaveBeenCalledTimes(10);
  });

  it('reports a partial failure instead of success', async () => {
    mockPost.mockResolvedValue({
      data: {
        okCount: 1,
        results: [
          { id: 's0', ok: true },
          { id: 's1', ok: false },
        ],
      },
    });
    const { onTagged } = renderModal(['s0', 's1']);
    fireEvent.click(screen.getByTestId('tag-modal-apply-btn'));

    await waitFor(() => expect(onTagged).toHaveBeenCalled());
    expect(mockToast.warning).toHaveBeenCalledWith('Started generating tags for 1 of 2 items');
    expect(mockToast.success).not.toHaveBeenCalled();
    expect(mockStartJob).toHaveBeenCalledTimes(1);
  });
});
