import type { BulkAbuseExecuteResult, BulkAbusePreview } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MutateOptions<T> = { onSuccess?: (data: T) => void; onError?: (error: Error) => void };
const previewMutate = vi.fn();
const executeMutate = vi.fn();
const mutationState: { previewError: Error | null; executePending: boolean } = {
  previewError: null,
  executePending: false,
};

vi.mock('@client/app/hooks/data/adminBulkAbuse', () => ({
  useBulkAbusePreview: () => ({
    mutate: previewMutate,
    reset: vi.fn(),
    isPending: false,
    error: mutationState.previewError,
  }),
  useBulkAbuseExecute: () => ({
    mutate: executeMutate,
    reset: vi.fn(),
    isPending: mutationState.executePending,
    error: null,
  }),
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

const ALL_ACTIONS = { ban: true, revokeApiKeys: true, revokeSessions: true, clawbackFreeCredits: true };
const REASON = 'Credit farming cohort';

function renderModal(selectedUserIds: string[] = []) {
  const onExecuted = vi.fn();
  const onClose = vi.fn();
  render(
    <TestWrapper>
      <BulkAbuseResponseModal selectedUserIds={selectedUserIds} onClose={onClose} onExecuted={onExecuted} />
    </TestWrapper>
  );
  return { onExecuted, onClose };
}

const resolveExecuteWith = (value: BulkAbuseExecuteResult) =>
  executeMutate.mockImplementation((_req: unknown, options?: MutateOptions<BulkAbuseExecuteResult>) =>
    options?.onSuccess?.(value)
  );

const previewDomain = (value: string) => {
  fireEvent.change(screen.getByTestId('bulk-abuse-domain-input'), { target: { value } });
  fireEvent.click(screen.getByTestId('bulk-abuse-preview-btn'));
};

const applyWithReason = () => {
  fireEvent.change(screen.getByTestId('bulk-abuse-reason-input'), { target: { value: REASON } });
  fireEvent.click(screen.getByTestId('bulk-abuse-execute-btn'));
};

const resolvePreviewWith = (value: BulkAbusePreview) =>
  previewMutate.mockImplementation((_req: unknown, options?: MutateOptions<BulkAbusePreview>) =>
    options?.onSuccess?.(value)
  );

describe('BulkAbuseResponseModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mutationState.previewError = null;
    mutationState.executePending = false;
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
      {
        target: { kind: 'domain', domain: 'kashre.com' },
        actions: ALL_ACTIONS,
        previewToken: 'token-1',
        reason: REASON,
      },
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

  it('discards the preview when the domain is edited, so Apply cannot act on the old one', () => {
    resolvePreviewWith(preview());
    renderModal();

    previewDomain('kashre.com');
    fireEvent.change(screen.getByTestId('bulk-abuse-domain-input'), { target: { value: 'other.com' } });

    expect(screen.queryByTestId('bulk-abuse-preview-summary')).not.toBeInTheDocument();
    expect(screen.getByTestId('bulk-abuse-execute-btn')).toBeDisabled();
  });

  it('discards the preview when the target changes', () => {
    resolvePreviewWith(preview());
    renderModal([USER_ID]);

    fireEvent.click(screen.getByTestId('bulk-abuse-preview-btn'));
    fireEvent.click(screen.getByTestId('bulk-abuse-target-domain-radio'));

    expect(screen.queryByTestId('bulk-abuse-preview-summary')).not.toBeInTheDocument();
    expect(screen.getByTestId('bulk-abuse-execute-btn')).toBeDisabled();
  });

  it('keeps the batch cursor when the next batch is previewed again', () => {
    resolvePreviewWith(preview({ hasMore: true, nextAfterUserId: USER_ID }));
    resolveExecuteWith(executeResult({ hasMore: true, nextAfterUserId: NEXT_ID }));
    renderModal();

    previewDomain('kashre.com');
    applyWithReason();
    fireEvent.click(screen.getByTestId('bulk-abuse-next-batch-btn'));
    fireEvent.click(screen.getByTestId('bulk-abuse-preview-btn'));

    expect(previewMutate).toHaveBeenLastCalledWith(
      { target: { kind: 'domain', domain: 'kashre.com', afterUserId: NEXT_ID }, actions: ALL_ACTIONS },
      expect.anything()
    );
  });

  it('continues past a batch where every user was skipped', () => {
    resolvePreviewWith(
      preview({ includedCount: 0, sample: [], blocksDomain: null, hasMore: true, nextAfterUserId: NEXT_ID })
    );
    renderModal();

    previewDomain('kashre.com');
    expect(screen.getByTestId('bulk-abuse-execute-btn')).toBeDisabled();
    fireEvent.click(screen.getByTestId('bulk-abuse-next-batch-btn'));

    expect(previewMutate).toHaveBeenLastCalledWith(
      { target: { kind: 'domain', domain: 'kashre.com', afterUserId: NEXT_ID }, actions: ALL_ACTIONS },
      expect.anything()
    );
  });

  it('can still apply the domain block when every user in the batch was skipped', () => {
    resolvePreviewWith(preview({ includedCount: 0, sample: [] }));
    renderModal();

    previewDomain('kashre.com');
    expect(screen.getByTestId('bulk-abuse-execute-btn')).toHaveTextContent('Block domain only');
    applyWithReason();
    expect(executeMutate).toHaveBeenCalled();
  });

  it('shows a failed preview and leaves nothing to apply', () => {
    mutationState.previewError = new Error('A bulk abuse response cannot include your own account.');
    previewMutate.mockImplementation((_req: unknown, options?: MutateOptions<BulkAbusePreview>) =>
      options?.onError?.(new Error('denied'))
    );
    renderModal([USER_ID]);

    fireEvent.click(screen.getByTestId('bulk-abuse-preview-btn'));

    expect(screen.getByTestId('bulk-abuse-error')).toHaveTextContent('cannot include your own account');
    expect(screen.queryByTestId('bulk-abuse-preview-summary')).not.toBeInTheDocument();
    expect(screen.getByTestId('bulk-abuse-execute-btn')).toBeDisabled();
  });

  it('cannot be closed while a run is in flight', () => {
    mutationState.executePending = true;
    const { onClose } = renderModal();

    fireEvent.keyDown(screen.getByTestId('bulk-abuse-modal'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});
