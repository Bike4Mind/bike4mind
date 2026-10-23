import type { BulkAbuseExecuteResult, BulkAbusePreview } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MutateOptions<T> = { onSuccess?: (data: T) => void };
const previewMutate = vi.fn();
const executeMutate = vi.fn();
const mutation = (mutate: ReturnType<typeof vi.fn>) => ({ mutate, reset: vi.fn(), isPending: false, error: null });

vi.mock('@client/app/hooks/data/adminBulkAbuse', () => ({
  useBulkAbusePreview: () => mutation(previewMutate),
  useBulkAbuseExecute: () => mutation(executeMutate),
}));

import BulkAbuseResponseModal from './BulkAbuseResponseModal';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const USER_ID = 'b'.repeat(24);
const NEXT_ID = 'c'.repeat(24);

const preview = (overrides: Partial<BulkAbusePreview> = {}): BulkAbusePreview => ({
  excluded: [{ userId: 'd'.repeat(24), email: 'paid@kashre.com', reason: 'paid' }],
  hasMore: false,
  nextAfterUserId: null,
  includedCount: 1,
  sample: [{ id: USER_ID, email: 'bot@np.kashre.com', username: 'bot', isBanned: false, currentCredits: 50 }],
  alreadyBannedCount: 0,
  activeApiKeyCount: 1,
  clawbackCredits: 50,
  blocksDomain: 'kashre.com',
  previewToken: 'token-1',
  ...overrides,
});

const executeResult = (overrides: Partial<BulkAbuseExecuteResult> = {}): BulkAbuseExecuteResult => ({
  results: [],
  excluded: [],
  hasMore: false,
  nextAfterUserId: null,
  succeededCount: 1,
  failedCount: 0,
  bannedCount: 1,
  revokedApiKeyCount: 1,
  clawedBackCredits: 50,
  blockedDomain: 'kashre.com',
  ...overrides,
});

function renderModal(selectedUserIds: string[] = []) {
  const onExecuted = vi.fn();
  render(
    <TestWrapper>
      <BulkAbuseResponseModal selectedUserIds={selectedUserIds} onClose={vi.fn()} onExecuted={onExecuted} />
    </TestWrapper>
  );
  return { onExecuted };
}

const resolvePreviewWith = (value: BulkAbusePreview) =>
  previewMutate.mockImplementation((_req: unknown, options?: MutateOptions<BulkAbusePreview>) =>
    options?.onSuccess?.(value)
  );

describe('BulkAbuseResponseModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('previews a domain, then executes with the token and reason', () => {
    resolvePreviewWith(preview());
    executeMutate.mockImplementation((_req: unknown, options?: MutateOptions<BulkAbuseExecuteResult>) =>
      options?.onSuccess?.(executeResult())
    );
    const { onExecuted } = renderModal();

    expect(screen.getByTestId('bulk-abuse-execute-btn')).toBeDisabled();
    fireEvent.change(screen.getByTestId('bulk-abuse-domain-input'), { target: { value: '@Kashre.com' } });
    fireEvent.click(screen.getByTestId('bulk-abuse-preview-btn'));

    expect(previewMutate).toHaveBeenCalledWith(
      {
        target: { kind: 'domain', domain: 'kashre.com' },
        actions: { ban: true, revokeApiKeys: true, revokeSessions: true, clawbackFreeCredits: true },
      },
      expect.anything()
    );
    expect(screen.getByTestId('bulk-abuse-blocks-domain')).toHaveTextContent('kashre.com');
    expect(screen.getByTestId('bulk-abuse-excluded')).toHaveTextContent('paid account');

    // A reason is required before execute unlocks.
    expect(screen.getByTestId('bulk-abuse-execute-btn')).toBeDisabled();
    fireEvent.change(screen.getByTestId('bulk-abuse-reason-input'), { target: { value: 'Credit farming cohort' } });
    fireEvent.click(screen.getByTestId('bulk-abuse-execute-btn'));

    expect(executeMutate).toHaveBeenCalledWith(
      expect.objectContaining({ previewToken: 'token-1', reason: 'Credit farming cohort' }),
      expect.anything()
    );
    expect(screen.getByTestId('bulk-abuse-result-summary')).toHaveTextContent('1 succeeded, 0 failed');
    expect(onExecuted).toHaveBeenCalled();
  });

  it('targets the selected users by default', () => {
    resolvePreviewWith(preview({ blocksDomain: null }));
    renderModal([USER_ID]);

    fireEvent.click(screen.getByTestId('bulk-abuse-action-ban-checkbox'));
    fireEvent.click(screen.getByTestId('bulk-abuse-preview-btn'));

    expect(previewMutate).toHaveBeenCalledWith(
      {
        target: { kind: 'users', userIds: [USER_ID] },
        actions: { ban: false, revokeApiKeys: true, revokeSessions: true, clawbackFreeCredits: true },
      },
      expect.anything()
    );
  });

  it('discards the preview when the actions change', () => {
    resolvePreviewWith(preview());
    renderModal([USER_ID]);

    fireEvent.click(screen.getByTestId('bulk-abuse-preview-btn'));
    expect(screen.getByTestId('bulk-abuse-preview-summary')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('bulk-abuse-action-revokeApiKeys-checkbox'));

    expect(screen.queryByTestId('bulk-abuse-preview-summary')).not.toBeInTheDocument();
    expect(screen.getByTestId('bulk-abuse-execute-btn')).toBeDisabled();
  });

  it('continues a domain past the batch cap from the returned cursor', () => {
    resolvePreviewWith(preview({ hasMore: true, nextAfterUserId: USER_ID }));
    executeMutate.mockImplementation((_req: unknown, options?: MutateOptions<BulkAbuseExecuteResult>) =>
      options?.onSuccess?.(executeResult({ hasMore: true, nextAfterUserId: NEXT_ID }))
    );
    renderModal();

    fireEvent.change(screen.getByTestId('bulk-abuse-domain-input'), { target: { value: 'kashre.com' } });
    fireEvent.click(screen.getByTestId('bulk-abuse-preview-btn'));
    fireEvent.change(screen.getByTestId('bulk-abuse-reason-input'), { target: { value: 'Credit farming cohort' } });
    fireEvent.click(screen.getByTestId('bulk-abuse-execute-btn'));
    fireEvent.click(screen.getByTestId('bulk-abuse-next-batch-btn'));

    expect(previewMutate).toHaveBeenLastCalledWith(
      expect.objectContaining({ target: { kind: 'domain', domain: 'kashre.com', afterUserId: NEXT_ID } }),
      expect.anything()
    );
  });

  it('disables preview for an invalid domain', () => {
    renderModal();
    fireEvent.change(screen.getByTestId('bulk-abuse-domain-input'), { target: { value: 'not a domain' } });
    expect(screen.getByTestId('bulk-abuse-preview-btn')).toBeDisabled();
  });
});
