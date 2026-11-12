import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import React from 'react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const mockGet = vi.fn();
const mockPost = vi.fn();
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: (...a: unknown[]) => mockGet(...a), post: (...a: unknown[]) => mockPost(...a) },
}));
const gate = vi.hoisted(() => ({ blocked: false, modelTypes: new Map<string, string>() }));
vi.mock('../../Models/ModelWriteAction', () => ({
  ModelWriteAction: ({ children }: { children: (disabled: boolean) => React.ReactElement }) => children(gate.blocked),
}));
vi.mock('../../Models/Discovery/useModelIndex', () => ({
  useModelIndex: () => ({
    data: { byId: new Map([...gate.modelTypes].map(([id, type]) => [id, { id, type }])), truncated: false },
  }),
}));

import { ModelPricingCatalog } from './ModelPricingCatalog';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const ROWS = [
  {
    modelId: 'gpt-x',
    unit: 'per_token',
    pricing: { '0': { input: 4e-6, output: 16e-6 } },
    effectiveFrom: '2026-07-01T00:00:00.000Z',
    note: 'adapter-seed',
  },
  {
    modelId: 'gpt-y',
    unit: 'per_token',
    pricing: { '0': { input: 9e-6, output: 27e-6 } },
    effectiveFrom: '2026-07-05T00:00:00.000Z',
    note: 'manual reprice per invoice',
  },
];

/** The (modelId, unit) pairs the server can revert to a seed. */
const SEEDED = [
  { modelId: 'gpt-x', unit: 'per_token' },
  { modelId: 'gpt-y', unit: 'per_token' },
];

const DISCOVERY_ROW = {
  modelId: 'gpt-z',
  unit: 'per_token',
  pricing: { '0': { input: 2e-6, output: 8e-6 } },
  effectiveFrom: '2026-07-20T00:00:00.000Z',
  note: 'discovery:openrouter@2026-07-20',
  repricedBy: 'model-discovery',
};

function renderCatalog(toolbarActions?: React.ReactNode) {
  return render(
    <TestWrapper>
      <ModelPricingCatalog toolbarActions={toolbarActions} />
    </TestWrapper>
  );
}

describe('ModelPricingCatalog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gate.blocked = false;
    gate.modelTypes = new Map();
    mockGet.mockResolvedValue({ data: { seeded: SEEDED, rows: ROWS } });
    mockPost.mockResolvedValue({ data: { row: {} } });
  });

  it('names each source in plain words on a neutral chip, with what it means on hover', async () => {
    renderCatalog();
    expect(await screen.findByTestId('model-pricing-row-gpt-x-per_token')).toBeInTheDocument();
    const seed = screen.getByTestId('model-pricing-source-gpt-x-per_token');
    const admin = screen.getByTestId('model-pricing-source-gpt-y-per_token');
    expect(seed).toHaveTextContent('Default');
    expect(seed).toHaveAttribute('title', 'Value shipped in code or a seed row');
    expect(admin).toHaveTextContent('Set by admin');
    expect(admin).toHaveAttribute('title', 'Value an admin saved here');
    for (const chip of [seed, admin]) expect(chip).toHaveClass('MuiChip-colorNeutral');
  });

  it('keeps the full catalog visible without locally paging away models', async () => {
    mockGet.mockResolvedValue({
      data: { rows: Array.from({ length: 30 }, (_, index) => ({ ...ROWS[0], modelId: `model-${index}` })) },
    });
    renderCatalog();
    expect(await screen.findByTestId('model-pricing-row-model-29-per_token')).toBeInTheDocument();
    expect(screen.getAllByTestId(/^model-pricing-row-/)).toHaveLength(30);
  });

  it('renders discovery rows as their own provenance, named by the feed that priced them', async () => {
    mockGet.mockResolvedValue({ data: { seeded: SEEDED, rows: [...ROWS, DISCOVERY_ROW] } });
    renderCatalog();
    const chip = await screen.findByTestId('model-pricing-source-gpt-z-per_token');
    expect(chip).toHaveTextContent('Discovered');
    expect(chip).toHaveAttribute('data-provenance', 'discovery');
    expect(chip).toHaveClass('MuiChip-colorNeutral');
    // Which feed priced it, without making an admin open history.
    expect(chip).toHaveAttribute('title', 'Value read from a provider feed (openrouter)');
    expect(screen.getByTestId('model-pricing-source-gpt-x-per_token')).toHaveTextContent('Default');
    expect(screen.getByTestId('model-pricing-source-gpt-y-per_token')).toHaveTextContent('Set by admin');
  });

  it('marks a discovery row in history so an audit can tell automation from an operator', async () => {
    renderCatalog();
    await screen.findByTestId('model-pricing-row-gpt-x-per_token');
    mockGet.mockResolvedValueOnce({
      data: {
        history: [
          { ...DISCOVERY_ROW, modelId: 'gpt-x' },
          {
            modelId: 'gpt-x',
            unit: 'per_token',
            pricing: { '0': { input: 4e-6, output: 16e-6 } },
            effectiveFrom: '2026-07-01T00:00:00.000Z',
            note: 'adapter-seed',
          },
        ],
      },
    });
    fireEvent.click(screen.getByTestId('model-pricing-history-gpt-x-per_token'));
    const rows = await screen.findAllByTestId('history-row');

    const newest = within(rows[0]);
    const who = newest.getByTestId('history-who');
    expect(who).toHaveTextContent('model-discovery');
    expect(who).toHaveAttribute('data-provenance', 'discovery');
    expect(newest.getByText('discovery:openrouter@2026-07-20')).toBeInTheDocument();

    // The seed row underneath is still marked as its own provenance.
    expect(within(rows[1]).getByTestId('history-who')).toHaveAttribute('data-provenance', 'seed');
  });

  it('reprice requires a note before saving, then posts the new rates', async () => {
    renderCatalog();
    fireEvent.click(await screen.findByTestId('model-pricing-reprice-gpt-x-per_token'));

    const save = screen.getByTestId('reprice-save-btn');
    expect(save).toHaveAttribute('disabled');
    expect(mockPost).not.toHaveBeenCalled();

    // Entered in the displayed unit ($/1M), posted as the stored per-token rate.
    fireEvent.change(screen.getByTestId('reprice-rate-0-input'), { target: { value: '5' } });
    fireEvent.change(screen.getByTestId('reprice-note-input'), { target: { value: 'openai price page 2026-07' } });
    fireEvent.click(screen.getByTestId('reprice-save-btn'));

    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    const [url, body] = mockPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe('/api/admin/model-prices');
    expect(body).toMatchObject({
      modelId: 'gpt-x',
      note: 'openai price page 2026-07',
      pricing: { '0': { input: 5e-6, output: 16e-6 } },
    });
    // The markup is never written; the row stays raw provider cost.
    expect(body).not.toHaveProperty('confirm');
  });

  it('edits token rates in the displayed unit: a stored 3e-6 opens as 3 and a saved 0.2 posts 2e-7', async () => {
    mockGet.mockResolvedValue({
      data: {
        rows: [
          {
            modelId: 'gpt-cheap',
            unit: 'per_token',
            pricing: { '0': { input: 3e-6, output: 12e-6 } },
            effectiveFrom: '2026-07-01T00:00:00.000Z',
            note: 'adapter-seed',
          },
        ],
      },
    });
    renderCatalog();
    fireEvent.click(await screen.findByTestId('model-pricing-reprice-gpt-cheap-per_token'));

    // What the table shows ($3.00) is what the editor seeds.
    expect(screen.getByTestId('reprice-rate-0-input')).toHaveValue('3');
    expect(screen.getByTestId('reprice-rate-0-output')).toHaveValue('12');

    fireEvent.change(screen.getByTestId('reprice-rate-0-input'), { target: { value: '0.2' } });
    fireEvent.change(screen.getByTestId('reprice-note-input'), { target: { value: 'provider price page' } });
    fireEvent.click(screen.getByTestId('reprice-save-btn'));

    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    const body = mockPost.mock.calls[0][1] as { pricing: Record<string, Record<string, number>> };
    // Exactly 2e-7: the division's float noise is trimmed, not stored.
    expect(body.pricing['0'].input).toBe(2e-7);
    expect(body.pricing['0'].output).toBe(12e-6);
  });

  it('presents a stored rate carrying 1e6 round-trip float noise as its readable value', async () => {
    mockGet.mockResolvedValue({
      data: {
        rows: [
          {
            modelId: 'gpt-noisy',
            unit: 'per_token',
            // Real production value: 15 $/1M that survived a 1e6 round trip.
            pricing: { '0': { input: 1.4999999999999999e-5, output: 6e-5 } },
            effectiveFrom: '2026-07-01T00:00:00.000Z',
            note: 'adapter-seed',
          },
        ],
      },
    });
    renderCatalog();
    fireEvent.click(await screen.findByTestId('model-pricing-reprice-gpt-noisy-per_token'));
    expect(screen.getByTestId('reprice-rate-0-input')).toHaveValue('15');
    expect(screen.getByTestId('reprice-rate-0-input')).not.toHaveValue('14.999999999999998');
  });

  it('leaves a per_minute row unscaled in both directions (no x1M on open, no /1M on save)', async () => {
    mockGet.mockResolvedValue({
      data: {
        rows: [
          {
            modelId: 'voice-conversational',
            unit: 'per_minute',
            pricing: { '0': { input: 0.06, output: 0 } },
            effectiveFrom: '2026-07-01T00:00:00.000Z',
            note: 'adapter-seed',
          },
        ],
      },
    });
    renderCatalog();
    fireEvent.click(await screen.findByTestId('model-pricing-reprice-voice-conversational-per_minute'));
    expect(screen.getByTestId('reprice-rate-0-input')).toHaveValue('0.06');

    fireEvent.change(screen.getByTestId('reprice-rate-0-input'), { target: { value: '0.09' } });
    fireEvent.change(screen.getByTestId('reprice-note-input'), { target: { value: 'realtime price page' } });
    fireEvent.click(screen.getByTestId('reprice-save-btn'));

    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    expect(mockPost.mock.calls[0][1]).toMatchObject({
      unit: 'per_minute',
      pricing: { '0': { input: 0.09, output: 0 } },
    });
  });

  it('shows what a user pays at the published markup as a read-only derived line', async () => {
    renderCatalog();
    fireEvent.click(await screen.findByTestId('model-pricing-reprice-gpt-x-per_token'));
    // gpt-x stores 4e-6 / 16e-6 -> $4 and $16 per 1M cost, x1.2 default markup.
    const derived = screen.getByTestId('reprice-markup-0');
    expect(derived).toHaveTextContent('$4.8');
    expect(derived).toHaveTextContent('$19.2');
    expect(derived).toHaveTextContent('markup');
    // Editing the cost re-derives it without changing what gets posted.
    fireEvent.change(screen.getByTestId('reprice-rate-0-input'), { target: { value: '10' } });
    expect(screen.getByTestId('reprice-markup-0')).toHaveTextContent('$12');
    expect(screen.getByTestId('reprice-rate-0-input')).toHaveValue('10');
  });

  it('offers a confirm path that echoes the waiver token the server issued', async () => {
    mockPost.mockRejectedValueOnce({
      message: 'Request failed with status code 400',
      response: {
        data: {
          code: 'manual-reprice-over-band',
          confirmToken: 'a1b2c3d4e5f60718',
          error: 'gpt-x input: $4 -> $4000 per 1M tokens is a 1000x move, beyond the 10x manual reprice band',
        },
      },
    });
    renderCatalog();
    fireEvent.click(await screen.findByTestId('model-pricing-reprice-gpt-x-per_token'));
    fireEvent.change(screen.getByTestId('reprice-rate-0-input'), { target: { value: '4000' } });
    fireEvent.change(screen.getByTestId('reprice-note-input'), { target: { value: 'provider price page' } });
    fireEvent.click(screen.getByTestId('reprice-save-btn'));

    expect(await screen.findByTestId('reprice-modal-error')).toHaveTextContent('1000x move');
    expect(mockPost.mock.calls[0][1]).not.toHaveProperty('confirm');

    fireEvent.click(screen.getByTestId('reprice-confirm-band-btn'));
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(2));
    expect(mockPost.mock.calls[1][1]).toMatchObject({
      modelId: 'gpt-x',
      // The exact token, not a boolean: the server re-derives it from this draft.
      confirm: 'a1b2c3d4e5f60718',
      pricing: { '0': { input: 4e-3 } },
    });
  });

  it('surfaces EVERY enumerated violation, not just the first line of the rejection', async () => {
    mockPost.mockRejectedValueOnce({
      response: {
        data: {
          code: 'manual-reprice-over-band',
          confirmToken: 'deadbeefdeadbeef',
          error:
            'gpt-x (per_token): 2 changes need confirmation before they can settle calls:\n' +
            '- gpt-x input (tier 0): $4 -> $120 per 1M tokens is a 30x move, beyond the 10x manual reprice band\n' +
            '- gpt-x output (tier 0): $16 -> $16000000 per 1M tokens is a 1000000x move, beyond the 10x manual reprice band\n' +
            'review every line, then resubmit with confirm set to the confirmToken in this response.',
        },
      },
    });
    renderCatalog();
    fireEvent.click(await screen.findByTestId('model-pricing-reprice-gpt-x-per_token'));
    fireEvent.change(screen.getByTestId('reprice-rate-0-input'), { target: { value: '120' } });
    fireEvent.change(screen.getByTestId('reprice-rate-0-output'), { target: { value: '16000000' } });
    fireEvent.change(screen.getByTestId('reprice-note-input'), { target: { value: 'provider price page' } });
    fireEvent.click(screen.getByTestId('reprice-save-btn'));

    const alert = await screen.findByTestId('reprice-modal-error');
    expect(alert).toHaveTextContent('input (tier 0): $4 -> $120 per 1M tokens is a 30x move');
    expect(alert).toHaveTextContent('output (tier 0): $16 -> $16000000 per 1M tokens is a 1000000x move');
    // Newlines must survive into the Alert or the lines run together.
    expect(alert).toHaveStyle({ whiteSpace: 'pre-line' });
  });

  it('withdraws the over-band confirm once the rejected rate is edited', async () => {
    mockPost.mockRejectedValueOnce({
      response: {
        data: {
          code: 'manual-reprice-over-band',
          confirmToken: 'a1b2c3d4e5f60718',
          error: 'beyond the 10x manual reprice band',
        },
      },
    });
    renderCatalog();
    fireEvent.click(await screen.findByTestId('model-pricing-reprice-gpt-x-per_token'));
    fireEvent.change(screen.getByTestId('reprice-rate-0-input'), { target: { value: '4000' } });
    fireEvent.change(screen.getByTestId('reprice-note-input'), { target: { value: 'provider price page' } });
    fireEvent.click(screen.getByTestId('reprice-save-btn'));
    await screen.findByTestId('reprice-confirm-band-btn');

    fireEvent.change(screen.getByTestId('reprice-rate-0-input'), { target: { value: '4.5' } });
    expect(screen.queryByTestId('reprice-confirm-band-btn')).toBeNull();
  });

  it('offers no waiver for a rejection that carries no token (nothing to confirm)', async () => {
    mockPost.mockRejectedValueOnce({
      response: { data: { error: "tier key '0200000' has a leading zero" } },
    });
    renderCatalog();
    fireEvent.click(await screen.findByTestId('model-pricing-reprice-gpt-x-per_token'));
    fireEvent.change(screen.getByTestId('reprice-note-input'), { target: { value: 'provider price page' } });
    fireEvent.click(screen.getByTestId('reprice-save-btn'));

    expect(await screen.findByTestId('reprice-modal-error')).toHaveTextContent('leading zero');
    expect(screen.queryByTestId('reprice-confirm-band-btn')).toBeNull();
  });

  it('revert-to-seed is offered only on operator rows and posts the action after confirm', async () => {
    renderCatalog();
    await screen.findByTestId('model-pricing-row-gpt-x-per_token');
    expect(screen.queryByTestId('model-pricing-revert-gpt-x-per_token')).toBeNull();

    fireEvent.click(screen.getByTestId('model-pricing-revert-gpt-y-per_token'));
    fireEvent.click(screen.getByTestId('revert-confirm-btn'));

    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    expect(mockPost.mock.calls[0][1]).toMatchObject({ modelId: 'gpt-y', action: 'revert-to-seed' });
  });

  it('offers no revert on an admin-set row the server has no seed for', async () => {
    mockGet.mockResolvedValue({ data: { seeded: [SEEDED[0]], rows: ROWS } });
    renderCatalog();
    await screen.findByTestId('model-pricing-row-gpt-y-per_token');

    expect(screen.queryByTestId('model-pricing-revert-gpt-y-per_token')).not.toBeInTheDocument();
    expect(screen.getByTestId('model-pricing-reprice-gpt-y-per_token')).toBeInTheDocument();
  });

  it('formats non-token units at face value with a unit label (a per-minute rate must not be inflated x1M)', async () => {
    mockGet.mockResolvedValue({
      data: {
        rows: [
          ...ROWS,
          {
            modelId: 'voice-conversational',
            unit: 'per_minute',
            pricing: { '0': { input: 0.06, output: 0 } },
            effectiveFrom: '2026-07-01T00:00:00.000Z',
            note: 'adapter-seed',
          },
        ],
      },
    });
    renderCatalog();
    const row = await screen.findByTestId('model-pricing-row-voice-conversational-per_minute');
    expect(row).toHaveTextContent('$0.06');
    expect(row).not.toHaveTextContent('60,000');
    expect(row).toHaveTextContent('per minute');
  });

  it('surfaces the server validation message inside the open reprice modal on failure', async () => {
    mockPost.mockRejectedValue({
      message: 'Request failed with status code 400',
      response: { data: { message: "note 'adapter-seed' is reserved for seed provenance" } },
    });
    renderCatalog();
    fireEvent.click(await screen.findByTestId('model-pricing-reprice-gpt-x-per_token'));
    fireEvent.change(screen.getByTestId('reprice-note-input'), { target: { value: 'adapter-seed' } });
    fireEvent.click(screen.getByTestId('reprice-save-btn'));

    const alert = await screen.findByTestId('reprice-modal-error');
    expect(alert).toHaveTextContent('reserved for seed provenance');
  });

  it('renders history as a diff with who and why; oldest row shows plain rates', async () => {
    renderCatalog();
    await screen.findByTestId('model-pricing-row-gpt-x-per_token');
    mockGet.mockResolvedValueOnce({
      data: {
        history: [
          {
            modelId: 'gpt-x',
            unit: 'per_token',
            pricing: { '0': { input: 9e-6, output: 27e-6 } },
            effectiveFrom: '2026-07-05T00:00:00.000Z',
            note: 'invoice X',
            repricedBy: 'admin-1',
          },
          {
            modelId: 'gpt-x',
            unit: 'per_token',
            pricing: { '0': { input: 4e-6, output: 16e-6 } },
            effectiveFrom: '2026-07-01T00:00:00.000Z',
            note: 'adapter-seed',
          },
        ],
      },
    });
    fireEvent.click(screen.getByTestId('model-pricing-history-gpt-x-per_token'));
    const rows = await screen.findAllByTestId('history-row');
    expect(rows).toHaveLength(2);

    const newest = within(rows[0]);
    expect(newest.getByTestId('history-who')).toHaveTextContent('admin-1');
    expect(newest.getByText('invoice X')).toBeInTheDocument();
    // Diff against the older row: input $4 -> $9, output $16 -> $27.
    expect(newest.getByTestId('history-diff-0-input')).toHaveTextContent('$4');
    expect(newest.getByTestId('history-diff-0-input')).toHaveTextContent('$9');
    expect(newest.getByTestId('history-diff-0-output')).toHaveTextContent('$16');
    expect(newest.getByTestId('history-diff-0-output')).toHaveTextContent('$27');

    const oldest = within(rows[1]);
    expect(oldest.getByTestId('history-who')).toHaveTextContent('Default');
    expect(oldest.queryByTestId('history-diff-0-input')).not.toBeInTheDocument();
    expect(oldest.getByText(/\$4/)).toBeInTheDocument();
  });

  it('diffs every tier, not just the first (multi-tier reprice audit)', async () => {
    renderCatalog();
    await screen.findByTestId('model-pricing-row-gpt-x-per_token');
    mockGet.mockResolvedValueOnce({
      data: {
        history: [
          {
            modelId: 'gpt-x',
            unit: 'per_token',
            pricing: { '272000': { input: 1e-6, output: 6e-6 }, '1050000': { input: 3e-6, output: 9e-6 } },
            effectiveFrom: '2026-07-05T00:00:00.000Z',
            note: 'long-context tier reprice',
            repricedBy: 'admin-1',
          },
          {
            modelId: 'gpt-x',
            unit: 'per_token',
            pricing: { '272000': { input: 1e-6, output: 6e-6 }, '1050000': { input: 2e-6, output: 9e-6 } },
            effectiveFrom: '2026-07-01T00:00:00.000Z',
            note: 'adapter-seed',
          },
        ],
      },
    });
    fireEvent.click(screen.getByTestId('model-pricing-history-gpt-x-per_token'));
    const rows = await screen.findAllByTestId('history-row');
    const newest = within(rows[0]);
    // Only the 1050000 tier's input changed ($2 -> $3); the first tier must not diff.
    const diff = newest.getByTestId('history-diff-1050000-input');
    expect(diff).toHaveTextContent('$2');
    expect(diff).toHaveTextContent('$3');
    expect(newest.queryByTestId('history-diff-272000-input')).not.toBeInTheDocument();
    expect(newest.queryByText('no rate changes')).not.toBeInTheDocument();
  });

  it('shows who performed a revert even though the row carries the seed note', async () => {
    renderCatalog();
    await screen.findByTestId('model-pricing-row-gpt-x-per_token');
    mockGet.mockResolvedValueOnce({
      data: {
        history: [
          {
            modelId: 'gpt-x',
            unit: 'per_token',
            pricing: { '0': { input: 4e-6, output: 16e-6 } },
            effectiveFrom: '2026-07-06T00:00:00.000Z',
            note: 'adapter-seed',
            repricedBy: 'admin-1',
          },
        ],
      },
    });
    fireEvent.click(screen.getByTestId('model-pricing-history-gpt-x-per_token'));
    const rows = await screen.findAllByTestId('history-row');
    expect(within(rows[0]).getByTestId('history-who')).toHaveTextContent('admin-1');
  });

  it('ignores a stale history response when a newer model was opened (no cross-model audit mixups)', async () => {
    renderCatalog();
    await screen.findByTestId('model-pricing-row-gpt-x-per_token');

    let resolveSlow: (v: unknown) => void = () => {};
    const slow = new Promise(resolve => (resolveSlow = resolve));
    mockGet.mockReturnValueOnce(slow); // gpt-x history: slow
    fireEvent.click(screen.getByTestId('model-pricing-history-gpt-x-per_token'));

    mockGet.mockResolvedValueOnce({
      data: {
        history: [
          {
            modelId: 'gpt-y',
            pricing: { '0': { input: 9e-6, output: 27e-6 } },
            effectiveFrom: '2026-07-05T00:00:00.000Z',
            note: 'manual reprice per invoice',
          },
        ],
      },
    });
    fireEvent.click(screen.getByTestId('model-pricing-history-gpt-y-per_token'));
    await screen.findAllByTestId('history-row');

    resolveSlow({
      data: {
        history: [
          {
            modelId: 'gpt-x',
            pricing: { '0': { input: 1e-6, output: 2e-6 } },
            effectiveFrom: '2026-06-01T00:00:00.000Z',
            note: 'stale gpt-x row',
          },
        ],
      },
    });
    await waitFor(() => expect(screen.getByTestId('history-drawer')).toHaveTextContent('gpt-y'));
    expect(screen.getByTestId('history-drawer')).not.toHaveTextContent('stale gpt-x row');
  });

  it('filters the catalog by model id', async () => {
    renderCatalog();
    await screen.findByTestId('model-pricing-row-gpt-x-per_token');

    fireEvent.change(screen.getByTestId('admin-filter-search-input'), { target: { value: 'gpt-y' } });

    expect(screen.getByTestId('model-pricing-row-gpt-y-per_token')).toBeInTheDocument();
    expect(screen.queryByTestId('model-pricing-row-gpt-x-per_token')).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId('admin-filter-search-input'), { target: { value: 'nothing-like-this' } });
    expect(screen.getByTestId('model-pricing-filter-empty')).toHaveTextContent('No prices match these filters');
    expect(screen.queryByTestId('model-pricing-table')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('model-pricing-clear-filters-btn'));
    expect(screen.getByTestId('admin-filter-search-input')).toHaveValue('');
    expect(screen.getByTestId('model-pricing-row-gpt-x-per_token')).toBeInTheDocument();
  });

  it('shows skeleton rows until the first rows arrive', async () => {
    let resolve: (value: unknown) => void = () => undefined;
    mockGet.mockReturnValueOnce(new Promise(r => (resolve = r)));
    renderCatalog();
    expect(screen.getAllByTestId('admin-table-skeleton-row').length).toBeGreaterThan(0);
    expect(screen.queryByTestId('model-pricing-updating')).not.toBeInTheDocument();
    resolve({ data: { seeded: SEEDED, rows: ROWS } });
    expect(await screen.findByTestId('model-pricing-row-gpt-x-per_token')).toBeInTheDocument();
    expect(screen.queryByTestId('admin-table-skeleton-row')).not.toBeInTheDocument();
  });

  it('keeps the rows on screen under an updating bar while a refresh is in flight', async () => {
    renderCatalog();
    await screen.findByTestId('model-pricing-row-gpt-x-per_token');
    let resolve: (value: unknown) => void = () => undefined;
    mockGet.mockReturnValueOnce(new Promise(r => (resolve = r)));
    fireEvent.click(screen.getByTestId('model-pricing-refresh-btn'));

    expect(screen.getByTestId('model-pricing-updating')).toBeInTheDocument();
    expect(screen.getByTestId('model-pricing-row-gpt-x-per_token')).toBeInTheDocument();
    expect(screen.queryByTestId('admin-table-skeleton-row')).not.toBeInTheDocument();
    resolve({ data: { seeded: SEEDED, rows: ROWS } });
    await waitFor(() => expect(screen.queryByTestId('model-pricing-updating')).not.toBeInTheDocument());
  });

  it('lets only the latest of overlapping loads land', async () => {
    let resolveFirst: (value: unknown) => void = () => undefined;
    let resolveSecond: (value: unknown) => void = () => undefined;
    mockGet
      .mockReturnValueOnce(new Promise(r => (resolveFirst = r)))
      .mockReturnValueOnce(new Promise(r => (resolveSecond = r)));
    const { rerender } = render(
      <TestWrapper>
        <ModelPricingCatalog refreshKey={0} />
      </TestWrapper>
    );
    rerender(
      <TestWrapper>
        <ModelPricingCatalog refreshKey={1} />
      </TestWrapper>
    );
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));

    resolveSecond({ data: { seeded: SEEDED, rows: [ROWS[1]] } });
    expect(await screen.findByTestId('model-pricing-row-gpt-y-per_token')).toBeInTheDocument();
    resolveFirst({ data: { seeded: SEEDED, rows: [ROWS[0]] } });
    await act(async () => {});
    expect(screen.queryByTestId('model-pricing-row-gpt-x-per_token')).not.toBeInTheDocument();
    expect(screen.getByTestId('model-pricing-row-gpt-y-per_token')).toBeInTheDocument();
  });

  it('shows the load error with a retry when there are no rows, and recovers on retry', async () => {
    mockGet.mockRejectedValueOnce({ response: { data: { error: 'Catalog unavailable' } } });
    renderCatalog();
    expect(await screen.findByTestId('admin-error-state')).toHaveTextContent('Catalog unavailable');
    expect(screen.queryByTestId('model-pricing-table')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(await screen.findByTestId('model-pricing-row-gpt-x-per_token')).toBeInTheDocument();
    expect(screen.queryByTestId('admin-error-state')).not.toBeInTheDocument();
  });

  it('keeps the rows on screen when a refresh fails', async () => {
    renderCatalog();
    await screen.findByTestId('model-pricing-row-gpt-x-per_token');
    mockGet.mockRejectedValueOnce({ response: { data: { error: 'Catalog unavailable' } } });
    fireEvent.click(screen.getByTestId('model-pricing-refresh-btn'));

    expect(await screen.findByTestId('model-pricing-error')).toHaveTextContent('Catalog unavailable');
    expect(screen.getByTestId('model-pricing-row-gpt-x-per_token')).toBeInTheDocument();
    expect(screen.queryByTestId('admin-error-state')).not.toBeInTheDocument();
  });

  it('keeps a failed reprice inside its dialog, off the table', async () => {
    mockPost.mockRejectedValue({ response: { data: { error: 'Rates out of range' } } });
    renderCatalog();
    fireEvent.click(await screen.findByTestId('model-pricing-reprice-gpt-x-per_token'));
    fireEvent.change(screen.getByTestId('reprice-note-input'), { target: { value: 'invoice' } });
    fireEvent.click(screen.getByTestId('reprice-save-btn'));

    expect(await screen.findByTestId('reprice-modal-error')).toHaveTextContent('Rates out of range');
    expect(screen.queryByTestId('model-pricing-error')).not.toBeInTheDocument();
    expect(screen.getByTestId('model-pricing-table')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('model-pricing-revert-gpt-y-per_token'));
    expect(screen.queryByTestId('revert-modal-error')).not.toBeInTheDocument();
  });

  it('disables reprice and revert for an admin who cannot write, and keeps history open', async () => {
    gate.blocked = true;
    renderCatalog();
    await screen.findByTestId('model-pricing-row-gpt-y-per_token');
    expect(screen.getByTestId('model-pricing-reprice-gpt-y-per_token')).toBeDisabled();
    expect(screen.getByTestId('model-pricing-revert-gpt-y-per_token')).toBeDisabled();
    expect(screen.getByTestId('model-pricing-history-gpt-y-per_token')).toBeEnabled();
  });

  it('offers reprice and revert only for text, realtime-voice and unknown models', async () => {
    gate.modelTypes = new Map([
      ['gpt-x', 'text'],
      ['gpt-y', 'image'],
      ['voice-1', 'realtime-voice'],
    ]);
    mockGet.mockResolvedValue({
      data: {
        seeded: SEEDED,
        rows: [...ROWS, { ...ROWS[0], modelId: 'voice-1' }, { ...ROWS[0], modelId: 'unlisted' }],
      },
    });
    renderCatalog();
    await screen.findByTestId('model-pricing-row-gpt-y-per_token');
    expect(screen.getByTestId('model-pricing-reprice-gpt-x-per_token')).toBeInTheDocument();
    expect(screen.queryByTestId('model-pricing-reprice-gpt-y-per_token')).not.toBeInTheDocument();
    expect(screen.queryByTestId('model-pricing-revert-gpt-y-per_token')).not.toBeInTheDocument();
    expect(screen.getByTestId('model-pricing-history-gpt-y-per_token')).toBeInTheDocument();
    expect(screen.getByTestId('model-pricing-reprice-voice-1-per_token')).toBeInTheDocument();
    expect(screen.getByTestId('model-pricing-reprice-unlisted-per_token')).toBeInTheDocument();
  });

  it('asks a realtime voice reprice for audio rates above 0 on its lowest tier before saving', async () => {
    gate.modelTypes = new Map([['voice-1', 'realtime-voice']]);
    mockGet.mockResolvedValue({ data: { seeded: SEEDED, rows: [{ ...ROWS[1], modelId: 'voice-1' }] } });
    renderCatalog();
    fireEvent.click(await screen.findByTestId('model-pricing-reprice-voice-1-per_token'));
    fireEvent.change(screen.getByTestId('reprice-note-input'), { target: { value: 'provider price page' } });

    expect(screen.getByTestId('reprice-rate-0-audio_input')).toHaveValue('');
    expect(screen.getByTestId('reprice-save-btn')).toBeDisabled();
    expect(screen.getByTestId('reprice-voice-problem')).toHaveTextContent('audio in and audio out rates above 0');

    fireEvent.change(screen.getByTestId('reprice-rate-0-audio_input'), { target: { value: '32' } });
    fireEvent.change(screen.getByTestId('reprice-rate-0-audio_output'), { target: { value: '64' } });
    expect(screen.queryByTestId('reprice-voice-problem')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('reprice-save-btn'));

    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    expect(mockPost.mock.calls[0][1]).toMatchObject({
      modelId: 'voice-1',
      pricing: { '0': { input: 9e-6, output: 27e-6, audio_input: 32e-6, audio_output: 64e-6 } },
    });
  });

  it('lets the table scroll sideways on a phone instead of squeezing its columns', async () => {
    renderCatalog();
    const table = await screen.findByTestId('model-pricing-table');
    expect(getComputedStyle(table).minWidth).toBe('64rem');
  });

  it('shows only the model a controlled filter names, and reports edits to the host', async () => {
    const onChange = vi.fn();
    render(
      <TestWrapper>
        <ModelPricingCatalog modelFilter="gpt-y" onModelFilterChange={onChange} />
      </TestWrapper>
    );
    await screen.findByTestId('model-pricing-row-gpt-y-per_token');
    expect(screen.getByTestId('admin-filter-search-input')).toHaveValue('gpt-y');
    expect(screen.queryByTestId('model-pricing-row-gpt-x-per_token')).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId('admin-filter-search-input'), { target: { value: 'gpt' } });
    expect(onChange).toHaveBeenCalledWith('gpt');
  });

  it('titles itself as a section with the toolbar actions in the header', async () => {
    renderCatalog(<button data-testid="host-action-btn">Add price</button>);
    await screen.findByTestId('model-pricing-row-gpt-x-per_token');
    expect(screen.getByRole('heading', { level: 2, name: 'Model pricing (2)' })).toBeInTheDocument();
    const actions = screen.getByTestId('admin-page-header-actions');
    expect(within(actions).getByTestId('model-pricing-refresh-btn')).toBeInTheDocument();
    expect(within(actions).getByTestId('host-action-btn')).toBeInTheDocument();
  });

  it('drops its heading when embedded and keeps the toolbar actions beside the search', async () => {
    render(
      <TestWrapper>
        <ModelPricingCatalog hideHeading toolbarActions={<button data-testid="host-action-btn">Add price</button>} />
      </TestWrapper>
    );
    await screen.findByTestId('model-pricing-row-gpt-x-per_token');
    expect(screen.queryByTestId('admin-page-header')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(screen.getByTestId('admin-filter-search-input')).toBeInTheDocument();
    const actions = screen.getByTestId('model-pricing-toolbar-actions');
    expect(within(actions).getByTestId('model-pricing-refresh-btn')).toBeInTheDocument();
    expect(within(actions).getByTestId('host-action-btn')).toBeInTheDocument();
  });

  it('narrows a full id to that model alone', async () => {
    mockGet.mockResolvedValue({
      data: { seeded: SEEDED, rows: [...ROWS, { ...ROWS[0], modelId: 'gpt-x-mini' }] },
    });
    render(
      <TestWrapper>
        <ModelPricingCatalog modelFilter="gpt-x" onModelFilterChange={vi.fn()} />
      </TestWrapper>
    );
    await screen.findByTestId('model-pricing-row-gpt-x-per_token');
    expect(screen.queryByTestId('model-pricing-row-gpt-x-mini-per_token')).not.toBeInTheDocument();
  });

  it('reports a landed reprice and refetches when the refresh key changes', async () => {
    const onPricesChanged = vi.fn();
    const { rerender } = render(
      <TestWrapper>
        <ModelPricingCatalog onPricesChanged={onPricesChanged} refreshKey={0} />
      </TestWrapper>
    );
    await screen.findByTestId('model-pricing-row-gpt-x-per_token');
    const calls = mockGet.mock.calls.length;
    rerender(
      <TestWrapper>
        <ModelPricingCatalog onPricesChanged={onPricesChanged} refreshKey={1} />
      </TestWrapper>
    );
    await waitFor(() => expect(mockGet.mock.calls.length).toBeGreaterThan(calls));

    fireEvent.click(screen.getByTestId('model-pricing-reprice-gpt-x-per_token'));
    fireEvent.change(await screen.findByTestId('reprice-note-input'), { target: { value: 'invoice' } });
    fireEvent.click(screen.getByTestId('reprice-save-btn'));
    await waitFor(() => expect(onPricesChanged).toHaveBeenCalledTimes(1));
  });

  it('history drawer fetches and lists the audit trail for one model', async () => {
    renderCatalog();
    mockGet.mockResolvedValueOnce({
      data: {
        history: [
          {
            modelId: 'gpt-y',
            pricing: { '0': { input: 9e-6, output: 27e-6 } },
            effectiveFrom: '2026-07-05T00:00:00.000Z',
            note: 'manual reprice per invoice',
          },
          {
            modelId: 'gpt-y',
            pricing: { '0': { input: 8e-6, output: 24e-6 } },
            effectiveFrom: '2026-07-01T00:00:00.000Z',
            note: 'adapter-seed',
          },
        ],
      },
    });
    fireEvent.click(await screen.findByTestId('model-pricing-history-gpt-y-per_token'));

    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/api/admin/model-prices?history=gpt-y'));
    expect(await screen.findByTestId('history-drawer')).toBeInTheDocument();
    expect(screen.getAllByTestId('history-row')).toHaveLength(2);
  });
});
