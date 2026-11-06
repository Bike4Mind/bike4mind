import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminUsageReceipt, AdminUsageReceiptCall } from '@bike4mind/common';
import { ProfileTestWrapper } from '../../profileTestUtils';
import { UsageReceiptDrawer } from './UsageReceiptDrawer';

const mocks = vi.hoisted(() => ({ receipt: vi.fn() }));

vi.mock('@client/app/hooks/data/adminUserCredits', () => ({ useAdminUsageReceipt: mocks.receipt }));

const AT = '2026-11-05T10:00:00.000Z';
const TARGET = { requestId: 'quest-1', at: AT };

const cappedCall: AdminUsageReceiptCall = {
  id: 'e1',
  at: AT,
  feature: 'chat',
  model: 'claude-opus-5-5',
  source: 'web',
  status: 'ok',
  stopReason: 'max_tokens',
  latencyMs: 531_000,
  tokens: {
    input: 20_329,
    cacheRead: 0,
    cacheWrite: 17_983,
    output: 45_400,
    visibleOutput: 8,
    thinking: 45_392,
    basis: 'provider',
  },
  credits: { cost: 2016, charged: 1998, writtenOff: 18, reserved: 400 },
  costUsd: 1.008,
  limits: { maxOutputTokens: 128_000, capBound: true, creditCapOutputTokens: 45_400, stoppedForCredits: false },
  toolCalls: [{ name: 'web_search', count: 3 }],
  attachments: { count: 2, totalBytes: 1_843_200 },
  detailRecorded: true,
};

const receiptOf = (calls: AdminUsageReceiptCall[]): AdminUsageReceipt => ({
  requestId: 'quest-1',
  calls,
  ledger: [{ id: 't1', at: AT, type: 'text_generation_usage', credits: -1998, writtenOffCredits: 18 }],
  totals: { cost: 2016, charged: 1998, writtenOff: 18 },
});

const renderDrawer = () =>
  render(
    <ProfileTestWrapper>
      <UsageReceiptDrawer userId="u1" target={TARGET} onClose={vi.fn()} />
    </ProfileTestWrapper>
  );

beforeEach(() => {
  mocks.receipt.mockReset();
});

describe('UsageReceiptDrawer', () => {
  it('shows charged vs written off, the cap that bound, thinking, tools and attachment totals', () => {
    mocks.receipt.mockReturnValue({
      data: receiptOf([cappedCall]),
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    renderDrawer();

    expect(mocks.receipt).toHaveBeenCalledWith('u1', TARGET);
    expect(screen.getByTestId('usage-receipt-charged')).toHaveTextContent('1,998');
    expect(screen.getByTestId('usage-receipt-written-off')).toHaveTextContent('18');
    expect(screen.getByTestId('usage-receipt-cap')).toHaveTextContent('Bound: output lowered to 45,400 tokens');
    expect(screen.getByTestId('usage-receipt-thinking')).toHaveTextContent('45,392');
    const tools = screen.getByTestId('usage-receipt-tools');
    expect(within(tools).getByText('web_search x3')).toBeInTheDocument();
    expect(within(tools).getByText('2 (1.8 MB)')).toBeInTheDocument();
    expect(screen.getByTestId('usage-receipt-ledger')).toHaveTextContent('18 written off');
  });

  it('labels a background job by its operation', () => {
    mocks.receipt.mockReturnValue({
      data: receiptOf([{ ...cappedCall, feature: 'operations', source: 'system', operation: 'notebook_naming' }]),
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    renderDrawer();
    expect(screen.getByTestId('usage-receipt-source')).toHaveTextContent('System \u00b7 Notebook naming');
  });

  it('says "not recorded" for rows written before the receipt fields existed', () => {
    mocks.receipt.mockReturnValue({
      data: receiptOf([
        {
          ...cappedCall,
          detailRecorded: false,
          limits: { capBound: false, stoppedForCredits: false },
          toolCalls: [],
          attachments: { count: 0, totalBytes: 0 },
        },
      ]),
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    renderDrawer();
    expect(screen.getByTestId('usage-receipt-cap')).toHaveTextContent('Not recorded for this request');
  });

  it('shows an empty state when no usage was recorded', () => {
    mocks.receipt.mockReturnValue({ data: receiptOf([]), isLoading: false, isError: false, refetch: vi.fn() });
    renderDrawer();
    expect(screen.getByTestId('usage-receipt-empty')).toBeInTheDocument();
  });
});
