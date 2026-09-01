import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { DataLakeDocumentPurgeReceipt } from '@bike4mind/common';

const h = vi.hoisted(() => ({ mutate: vi.fn(), isPending: false }));
vi.mock('@client/app/hooks/data/dataLakes', () => ({
  usePurgeDataLakeDocument: () => ({ mutate: h.mutate, isPending: h.isPending }),
}));

import PurgeLakeDocumentAction from './PurgeLakeDocumentAction';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const RECEIPT: DataLakeDocumentPurgeReceipt = {
  dataLakeId: 'lake-1',
  datalakeTag: 'datalake:sales',
  fabFileId: 'f1',
  fileName: 'q3.pdf',
  chunksBefore: 12,
  chunksRemaining: 0,
  embeddingModels: ['text-embedding-3-small'],
  documentDeleted: true,
  storageObjectDeleted: true,
  storageObjectsTotal: 1,
  storageObjectsRemaining: 0,
  retrievalIndexOutcome: 'collocated' as const,
  verified: true,
  purgedAt: '2026-01-01T00:00:00.000Z',
  fileCount: 4,
  totalSizeBytes: 900,
};

const renderAction = (onPurged?: () => void, onPurgeComplete?: () => void) =>
  render(
    <TestWrapper>
      <PurgeLakeDocumentAction
        file={{ id: 'f1', fileName: 'q3.pdf' }}
        title="Q3"
        dataLakeId="lake-1"
        onPurgeComplete={onPurgeComplete}
        onPurged={onPurged}
      />
    </TestWrapper>
  );

describe('PurgeLakeDocumentAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.isPending = false;
  });

  it('confirms before destroying anything', async () => {
    const user = userEvent.setup();
    renderAction();
    await user.click(screen.getByTestId('datalake-purgefile-btn-f1'));
    expect(await screen.findByTestId('datalake-purgefile-confirm')).toBeTruthy();
    expect(h.mutate).not.toHaveBeenCalled();

    await user.click(screen.getByTestId('datalake-purgefile-confirm-btn'));
    expect(h.mutate).toHaveBeenCalledWith('f1', expect.anything());
  });

  it('shows the receipt, not just a toast - the owner has to be able to see what was destroyed', async () => {
    const user = userEvent.setup();
    h.mutate.mockImplementation((_id: string, opts: { onSuccess: (r: DataLakeDocumentPurgeReceipt) => void }) =>
      opts.onSuccess(RECEIPT)
    );
    renderAction();
    await user.click(screen.getByTestId('datalake-purgefile-btn-f1'));
    await user.click(screen.getByTestId('datalake-purgefile-confirm-btn'));

    const summary = await screen.findByTestId('datalake-purgefile-receipt-summary');
    expect(summary.textContent).toContain('12 chunk(s)');
    expect(summary.textContent).toContain('is gone');
  });

  it('does not claim the content is gone when the server did not verify it', async () => {
    const user = userEvent.setup();
    h.mutate.mockImplementation((_id: string, opts: { onSuccess: (r: DataLakeDocumentPurgeReceipt) => void }) =>
      opts.onSuccess({ ...RECEIPT, chunksRemaining: 5, verified: false })
    );
    renderAction();
    await user.click(screen.getByTestId('datalake-purgefile-btn-f1'));
    await user.click(screen.getByTestId('datalake-purgefile-confirm-btn'));

    const summary = await screen.findByTestId('datalake-purgefile-receipt-summary');
    expect(summary.textContent).toContain('not fully destroyed');
    expect(summary.textContent).toContain('5 chunk(s)');
    expect(summary.textContent).not.toContain('is gone');
  });

  it('says so when the stored copy of the file was left behind', async () => {
    // The document is gone but the bytes are not, and nothing else can name them any more.
    const user = userEvent.setup();
    h.mutate.mockImplementation((_id: string, opts: { onSuccess: (r: DataLakeDocumentPurgeReceipt) => void }) =>
      opts.onSuccess({ ...RECEIPT, storageObjectDeleted: false, storageObjectsRemaining: 1, verified: false })
    );
    renderAction();
    await user.click(screen.getByTestId('datalake-purgefile-btn-f1'));
    await user.click(screen.getByTestId('datalake-purgefile-confirm-btn'));

    expect((await screen.findByTestId('datalake-purgefile-receipt-storage')).textContent).toContain(
      'could not be removed'
    );
  });

  it('leaves the storage note out of a clean receipt', async () => {
    const user = userEvent.setup();
    h.mutate.mockImplementation((_id: string, opts: { onSuccess: (r: DataLakeDocumentPurgeReceipt) => void }) =>
      opts.onSuccess(RECEIPT)
    );
    renderAction();
    await user.click(screen.getByTestId('datalake-purgefile-btn-f1'));
    await user.click(screen.getByTestId('datalake-purgefile-confirm-btn'));

    await screen.findByTestId('datalake-purgefile-receipt-summary');
    expect(screen.queryByTestId('datalake-purgefile-receipt-storage')).toBeNull();
  });

  it('tells the host to drop its selection only after the receipt is dismissed', async () => {
    const user = userEvent.setup();
    const onPurged = vi.fn();
    h.mutate.mockImplementation((_id: string, opts: { onSuccess: (r: DataLakeDocumentPurgeReceipt) => void }) =>
      opts.onSuccess(RECEIPT)
    );
    renderAction(onPurged);
    await user.click(screen.getByTestId('datalake-purgefile-btn-f1'));
    await user.click(screen.getByTestId('datalake-purgefile-confirm-btn'));
    await screen.findByTestId('datalake-purgefile-receipt');
    expect(onPurged).not.toHaveBeenCalled();

    await user.click(screen.getByTestId('datalake-purgefile-receipt-close'));
    await waitFor(() => expect(onPurged).toHaveBeenCalled());
  });

  it('tells the host the file is unreadable as soon as the receipt arrives, not on dismissal', async () => {
    // The two hooks fire at different moments on purpose: the content is gone the instant the
    // server confirms it, but the dialog reporting that is still on screen. A host that waits for
    // dismissal keeps re-fetching a signed URL for an object that no longer exists.
    const user = userEvent.setup();
    const onPurgeComplete = vi.fn();
    h.mutate.mockImplementation((_id: string, opts: { onSuccess: (r: DataLakeDocumentPurgeReceipt) => void }) =>
      opts.onSuccess(RECEIPT)
    );
    renderAction(undefined, onPurgeComplete);
    await user.click(screen.getByTestId('datalake-purgefile-btn-f1'));
    await user.click(screen.getByTestId('datalake-purgefile-confirm-btn'));

    await screen.findByTestId('datalake-purgefile-receipt');
    expect(onPurgeComplete).toHaveBeenCalledTimes(1);
  });

  it('disables the trigger while a purge is in flight', async () => {
    // The only thing stopping a second fire from a single tab, and a double purge is what refunds
    // the owner's quota twice - so this guard has to be exercised, not assumed.
    h.isPending = true;
    renderAction();

    expect(screen.getByTestId('datalake-purgefile-btn-f1')).toBeDisabled();
  });

  it('disables the confirm button too, so an open dialog cannot fire a second purge', async () => {
    const user = userEvent.setup();
    const view = renderAction();
    await user.click(screen.getByTestId('datalake-purgefile-btn-f1'));
    await screen.findByTestId('datalake-purgefile-confirm');

    h.isPending = true;
    view.rerender(
      <TestWrapper>
        <PurgeLakeDocumentAction file={{ id: 'f1', fileName: 'q3.pdf' } as never} title="Q3" dataLakeId="lake-1" />
      </TestWrapper>
    );

    expect(screen.getByTestId('datalake-purgefile-confirm-btn')).toBeDisabled();
  });

  it('renders the receipt timestamp in the reader locale, not as a raw ISO string', async () => {
    const user = userEvent.setup();
    h.mutate.mockImplementation((_id: string, opts: { onSuccess: (r: DataLakeDocumentPurgeReceipt) => void }) =>
      opts.onSuccess(RECEIPT)
    );
    renderAction();
    await user.click(screen.getByTestId('datalake-purgefile-btn-f1'));
    await user.click(screen.getByTestId('datalake-purgefile-confirm-btn'));

    const dialog = await screen.findByTestId('datalake-purgefile-receipt');
    expect(dialog.textContent).toContain(new Date(RECEIPT.purgedAt).toLocaleString());
    expect(dialog.textContent).not.toContain(RECEIPT.purgedAt);
  });
});
