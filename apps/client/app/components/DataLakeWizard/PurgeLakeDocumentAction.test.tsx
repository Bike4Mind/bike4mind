import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { DataLakeDocumentPurgeReceipt } from '@bike4mind/common';

const h = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock('@client/app/hooks/data/dataLakes', () => ({
  usePurgeDataLakeDocument: () => ({ mutate: h.mutate, isPending: false }),
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
  retrievalIndexPurged: false,
  verified: true,
  purgedAt: '2026-01-01T00:00:00.000Z',
  fileCount: 4,
  totalSizeBytes: 900,
};

const renderAction = (onPurged?: () => void) =>
  render(
    <TestWrapper>
      <PurgeLakeDocumentAction
        file={{ id: 'f1', fileName: 'q3.pdf' }}
        title="Q3"
        dataLakeId="lake-1"
        onPurged={onPurged}
      />
    </TestWrapper>
  );

describe('PurgeLakeDocumentAction', () => {
  beforeEach(() => vi.clearAllMocks());

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
});
