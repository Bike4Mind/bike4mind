import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const mockGet = vi.fn();
const mockPost = vi.fn();
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: (...a: unknown[]) => mockGet(...a), post: (...a: unknown[]) => mockPost(...a) },
}));

// Stubbed: the card fetches and polls its own endpoint, which would otherwise
// show up in this file's api.get assertions. Covered by DiscoveryStatusCard.test.tsx.
vi.mock('./DiscoveryStatusCard', () => ({
  DiscoveryStatusCard: () => <div data-testid="discovery-status-card" />,
}));

import { ModelLifecycleTab } from './ModelLifecycleTab';
import { AdminTab } from './adminSidebarConfig';
import { useAdminModal } from './useAdminModal';
import { useCreditAnalysisStore } from './CreditAnalysis/store';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const STATUS = {
  daysAhead: 90,
  totalModels: 12,
  expiringOrExpired: [{ modelId: 'gpt-soon', name: 'Soon', deprecationDate: '2026-09-01', daysRemaining: 37 }],
  expired: [{ modelId: 'gpt-sunset', status: 'deprecated', deprecationDate: '2026-01-01', daysRemaining: -207 }],
  queue: [
    {
      modelId: 'gpt-sunset',
      suggestion: {
        status: 'deprecated',
        deprecationDate: '2026-08-01',
        replacedBy: 'gpt-live',
        source: 'anthropic-docs',
        suggestedAt: '2026-07-20T00:00:00.000Z',
      },
    },
  ],
  perMTokRates: {
    'gpt-sunset': { input: 0.3, output: 0.5 },
    'gpt-live': { input: 2, output: 6 },
    'gpt-newer': { input: 0.1, output: 0.25 },
  },
  staleReferences: [
    { surface: 'fallback-chain', key: 'gpt-live', referencedId: 'gpt-sunset', problem: 'deprecated' },
    { surface: 'fallback-default', key: 'default', referencedId: 'gpt-ghost', problem: 'unknown' },
    { surface: 'fallback-chain', key: 'gpt-live', referencedId: 'gpt-metadata-only', problem: 'not-invocable' },
  ],
};

const renderTab = () =>
  render(
    <TestWrapper>
      <ModelLifecycleTab />
    </TestWrapper>
  );

describe('ModelLifecycleTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue({ data: STATUS });
    mockPost.mockResolvedValue({ data: {} });
    useAdminModal.setState({ activeTab: AdminTab.ModelLifecycle });
    useCreditAnalysisStore.setState({ activeTab: 'users', pricingModelId: null });
  });

  it('renders the queue, the horizon and the stale references from one fetch', async () => {
    renderTab();

    expect(screen.getByTestId('discovery-status-card')).toBeInTheDocument();
    const row = await screen.findByTestId('model-lifecycle-queue-row-gpt-sunset');
    expect(row).toHaveTextContent('anthropic-docs');
    expect(row).toHaveTextContent('gpt-live');

    // The catalog entry wins over the live one for a model in both lists.
    expect(screen.getByTestId('model-lifecycle-horizon-row-gpt-sunset')).toHaveTextContent('207d ago');
    expect(screen.getByTestId('model-lifecycle-horizon-row-gpt-soon')).toHaveTextContent('in 37d');
    expect(screen.getByTestId('model-lifecycle-stale-row-fallback-chain-gpt-sunset')).toHaveTextContent('deprecated');
    expect(screen.getByTestId('model-lifecycle-stale-row-fallback-default-gpt-ghost')).toHaveTextContent('unknown');
  });

  it('renders a not-invocable reference as its own readable problem kind', async () => {
    renderTab();

    expect(await screen.findByTestId('model-lifecycle-stale-row-fallback-chain-gpt-metadata-only')).toHaveTextContent(
      'not invocable'
    );
  });

  it('accept requires a note, then posts the suggested successor with it', async () => {
    renderTab();
    fireEvent.click(await screen.findByTestId('model-lifecycle-accept-gpt-sunset'));

    const confirm = screen.getByTestId('model-lifecycle-accept-confirm-btn');
    expect(confirm).toHaveAttribute('disabled');
    expect(mockPost).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('model-lifecycle-note-input'), {
      target: { value: 'provider deprecation page' },
    });
    fireEvent.click(screen.getByTestId('model-lifecycle-accept-confirm-btn'));

    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    const [url, body] = mockPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe('/api/admin/model-deprecation-status');
    expect(body).toEqual({
      modelId: 'gpt-sunset',
      action: 'accept',
      note: 'provider deprecation page',
      replacedBy: 'gpt-live',
    });
  });

  it('sends an edited successor override instead of the suggested one', async () => {
    renderTab();
    fireEvent.click(await screen.findByTestId('model-lifecycle-accept-gpt-sunset'));
    fireEvent.change(screen.getByTestId('model-lifecycle-replacedby-input'), { target: { value: 'gpt-newer' } });
    fireEvent.change(screen.getByTestId('model-lifecycle-note-input'), { target: { value: 'operator pick' } });
    fireEvent.click(screen.getByTestId('model-lifecycle-accept-confirm-btn'));

    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    expect(mockPost.mock.calls[0][1]).toMatchObject({ replacedBy: 'gpt-newer' });
  });

  it('prices the suggested successor in the queue row', async () => {
    renderTab();

    expect(await screen.findByTestId('successor-cost-chip-gpt-sunset')).toHaveTextContent('costs more +1100% (12.0x)');
  });

  // The whole point of the panel: the operator overriding the suggestion is the
  // one making a cost decision, and a precomputed delta would price the wrong model.
  it('reprices the accept panel against the typed successor, not the suggested one', async () => {
    renderTab();
    fireEvent.click(await screen.findByTestId('model-lifecycle-accept-gpt-sunset'));

    expect(screen.getByTestId('successor-cost-panel')).toHaveTextContent('costs more');

    fireEvent.change(screen.getByTestId('model-lifecycle-replacedby-input'), { target: { value: 'gpt-newer' } });

    const panel = screen.getByTestId('successor-cost-panel');
    expect(panel).toHaveTextContent('no cost increase');
    expect(panel).toHaveTextContent('$0.300 to $0.100 / MTok (-67%)');
  });

  it('flags a typed successor with no price row rather than showing it as free', async () => {
    renderTab();
    fireEvent.click(await screen.findByTestId('model-lifecycle-accept-gpt-sunset'));
    fireEvent.change(screen.getByTestId('model-lifecycle-replacedby-input'), { target: { value: 'gpt-unpriced' } });

    expect(screen.getByTestId('successor-cost-panel')).toHaveTextContent('no price on file');
  });

  it('omits the cost surfaces when the response carries no rates', async () => {
    mockGet.mockResolvedValue({ data: { ...STATUS, perMTokRates: undefined } });
    renderTab();
    fireEvent.click(await screen.findByTestId('model-lifecycle-accept-gpt-sunset'));

    expect(screen.getByTestId('successor-cost-panel')).toHaveTextContent('no price on file');
  });

  it('dismiss confirms before posting, since the suggestion cannot be brought back', async () => {
    renderTab();
    fireEvent.click(await screen.findByTestId('model-lifecycle-dismiss-gpt-sunset'));

    expect(screen.getByTestId('model-lifecycle-dismiss-modal')).toBeInTheDocument();
    expect(mockPost).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('model-lifecycle-dismiss-confirm-btn'));

    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    expect(mockPost.mock.calls[0][1]).toEqual({ modelId: 'gpt-sunset', action: 'dismiss' });
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));
  });

  it('cancelling the dismiss confirmation posts nothing', async () => {
    renderTab();
    fireEvent.click(await screen.findByTestId('model-lifecycle-dismiss-gpt-sunset'));
    fireEvent.click(screen.getByTestId('model-lifecycle-dismiss-cancel-btn'));

    expect(mockPost).not.toHaveBeenCalled();
  });

  it('a double-clicked dismiss confirmation sends exactly one request', async () => {
    let settle = (_value: { data: Record<string, unknown> }) => {};
    mockPost.mockReturnValue(new Promise(resolve => (settle = resolve)));
    renderTab();
    fireEvent.click(await screen.findByTestId('model-lifecycle-dismiss-gpt-sunset'));

    const confirm = screen.getByTestId('model-lifecycle-dismiss-confirm-btn');
    fireEvent.click(confirm);
    await waitFor(() => expect(confirm).toHaveAttribute('disabled'));
    fireEvent.click(confirm);
    expect(screen.getByTestId('model-lifecycle-dismiss-gpt-sunset')).toHaveAttribute('disabled');

    settle({ data: {} });
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('surfaces the server validation message inside the open accept modal, and only there', async () => {
    mockPost.mockRejectedValue({
      message: 'Request failed with status code 400',
      response: { data: { message: 'replacedBy gpt-typo is unknown to the merged model list' } },
    });
    renderTab();
    fireEvent.click(await screen.findByTestId('model-lifecycle-accept-gpt-sunset'));
    fireEvent.change(screen.getByTestId('model-lifecycle-note-input'), { target: { value: 'operator pick' } });
    fireEvent.click(screen.getByTestId('model-lifecycle-accept-confirm-btn'));

    expect(await screen.findByTestId('model-lifecycle-accept-error')).toHaveTextContent('unknown to the merged model');
    expect(screen.queryByTestId('model-lifecycle-error')).not.toBeInTheDocument();

    // Cancelling must not leave the failure behind as a page banner.
    fireEvent.click(screen.getByTestId('model-lifecycle-accept-cancel-btn'));
    await waitFor(() => expect(screen.queryByTestId('model-lifecycle-accept-error')).not.toBeInTheDocument());
    expect(screen.queryByTestId('model-lifecycle-error')).not.toBeInTheDocument();
  });

  it('shows the run own account of the suggestion in the accept confirmation', async () => {
    mockGet.mockResolvedValue({
      data: {
        ...STATUS,
        queue: [
          {
            modelId: 'gpt-sunset',
            suggestion: {
              ...STATUS.queue[0].suggestion,
              detail: 'the provider names gpt-live to replace gpt-sunset, but it costs more',
            },
          },
        ],
      },
    });
    renderTab();
    fireEvent.click(await screen.findByTestId('model-lifecycle-accept-gpt-sunset'));

    expect(screen.getByTestId('model-lifecycle-accept-detail')).toHaveTextContent('but it costs more');
  });

  it('turns a 409 into the blocker list plus an accept-anyway that re-sends the acknowledgement', async () => {
    mockPost.mockRejectedValueOnce({
      message: 'Request failed with status code 409',
      response: {
        status: 409,
        data: {
          code: 'replacement-blocked',
          blockers: ['cost-not-lower'],
          details: ['it costs more than the model it would replace'],
        },
      },
    });
    renderTab();
    fireEvent.click(await screen.findByTestId('model-lifecycle-accept-gpt-sunset'));
    fireEvent.change(screen.getByTestId('model-lifecycle-note-input'), { target: { value: 'operator pick' } });
    fireEvent.click(screen.getByTestId('model-lifecycle-accept-confirm-btn'));

    const blockers = await screen.findByTestId('model-lifecycle-accept-blockers');
    expect(blockers).toHaveTextContent('it costs more than the model it would replace');
    // A refusal an operator may overrule is not the same thing as a failure.
    expect(screen.queryByTestId('model-lifecycle-accept-error')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('model-lifecycle-accept-confirm-btn'));

    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(2));
    expect(mockPost.mock.calls[0][1]).not.toHaveProperty('acknowledgeBlockers');
    expect(mockPost.mock.calls[1][1]).toMatchObject({ acknowledgeBlockers: true, replacedBy: 'gpt-live' });
    await waitFor(() => expect(screen.queryByTestId('model-lifecycle-accept-modal')).not.toBeInTheDocument());
  });

  it('drops held blockers when the operator picks a different successor', async () => {
    mockPost.mockRejectedValueOnce({
      response: { status: 409, data: { code: 'replacement-blocked', details: ['it is not active'] } },
    });
    renderTab();
    fireEvent.click(await screen.findByTestId('model-lifecycle-accept-gpt-sunset'));
    fireEvent.change(screen.getByTestId('model-lifecycle-note-input'), { target: { value: 'operator pick' } });
    fireEvent.click(screen.getByTestId('model-lifecycle-accept-confirm-btn'));
    await screen.findByTestId('model-lifecycle-accept-blockers');

    fireEvent.change(screen.getByTestId('model-lifecycle-replacedby-input'), { target: { value: 'gpt-newer' } });

    expect(screen.queryByTestId('model-lifecycle-accept-blockers')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('model-lifecycle-accept-confirm-btn'));
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(2));
    expect(mockPost.mock.calls[1][1]).not.toHaveProperty('acknowledgeBlockers');
  });

  it('labels the icon-only refresh control', async () => {
    renderTab();
    await screen.findByTestId('model-lifecycle-queue-row-gpt-sunset');

    expect(screen.getByRole('button', { name: 'Refresh model lifecycle status' })).toBe(
      screen.getByTestId('model-lifecycle-refresh-btn')
    );
  });

  it('links to Model Pricing, landing on the pricing sub-tab of another sidebar section', async () => {
    renderTab();
    await screen.findByTestId('model-lifecycle-queue-row-gpt-sunset');

    const link = screen.getByTestId('model-lifecycle-model-pricing-link');
    // A Joy Link with an onClick and no href renders an <a> with no href: not
    // focusable, not announced, unreachable by keyboard.
    expect(link.tagName).toBe('BUTTON');
    fireEvent.click(link);

    expect(useAdminModal.getState().activeTab).toBe(AdminTab.CreditAnalytics);
    expect(useCreditAnalysisStore.getState().activeTab).toBe('pricing');
    // The header link is not about one model, so nothing is put in focus.
    expect(useCreditAnalysisStore.getState().pricingModelId).toBeNull();
  });

  it('says so when nothing is awaiting a decision', async () => {
    mockGet.mockResolvedValue({ data: { ...STATUS, queue: [] } });
    renderTab();
    expect(await screen.findByTestId('model-lifecycle-queue-empty')).toBeInTheDocument();
  });
});
