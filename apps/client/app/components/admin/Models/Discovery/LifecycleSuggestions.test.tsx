import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  DELEGATE,
  FULL_ADMIN,
  LIFECYCLE,
  SUPPORT_ONLY,
  adminRow,
  apiError,
  makeWrapper,
  modelList,
  newQueryClient,
} from './__tests__/discoveryTestKit';
import type { AdminModelRow } from '@bike4mind/common';
import type { LifecycleStatus } from './discoveryApi';

const m = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  currentUser: { id: 'admin-1', isAdmin: true } as Record<string, unknown>,
  nav: { openModel: vi.fn(), openRun: vi.fn(), openSection: vi.fn(), openPrices: vi.fn() },
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: (...a: unknown[]) => m.get(...a), post: (...a: unknown[]) => m.post(...a) },
}));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: m.currentUser }) }));
vi.mock('../modelsNavigation', () => ({ useModelsNavigation: () => m.nav }));
vi.mock('sonner', () => ({ toast: m.toast }));

import { LifecycleSuggestions } from './LifecycleSuggestions';

const LIFECYCLE_PATH = '/api/admin/model-deprecation-status';
let queryClient = newQueryClient();
let lifecycle: LifecycleStatus = LIFECYCLE;
let sunsetLifecycle: AdminModelRow['lifecycle'] = {};

const lifecycleGets = () => m.get.mock.calls.filter(([url]) => url === LIFECYCLE_PATH).length;

const renderQueue = () => render(<LifecycleSuggestions />, { wrapper: makeWrapper(queryClient) });

const openMenuItem = async (action: 'accept' | 'dismiss', modelId = 'gpt-sunset') => {
  fireEvent.click(await screen.findByTestId(`discovery-suggestion-actions-${modelId}`));
  fireEvent.click(await screen.findByTestId(`discovery-suggestion-${action}-${modelId}`));
};

const typeSuccessor = (value: string) =>
  fireEvent.change(screen.getByTestId('discovery-accept-successor-input'), { target: { value } });

const writeReason = (dialog: 'accept' | 'dismiss', value: string) =>
  fireEvent.change(screen.getByTestId(`discovery-${dialog}-dialog-reason-input`), { target: { value } });

const confirm = (dialog: 'accept' | 'dismiss') => screen.getByTestId(`discovery-${dialog}-dialog-confirm-btn`);

beforeEach(() => {
  vi.clearAllMocks();
  queryClient = newQueryClient();
  m.currentUser = FULL_ADMIN;
  lifecycle = LIFECYCLE;
  sunsetLifecycle = {};
  m.get.mockImplementation(async (url: string) => {
    if (url === LIFECYCLE_PATH) return { data: lifecycle };
    if (url === '/api/admin/models') {
      return {
        data: modelList([
          adminRow('gpt-sunset', { name: 'GPT Sunset', lifecycle: sunsetLifecycle }),
          adminRow('gpt-live', { name: 'GPT Live' }),
          adminRow('gpt-newer', { name: 'GPT Newer' }),
        ]),
      };
    }
    throw new Error(`unexpected GET ${url}`);
  });
  m.post.mockResolvedValue({ data: { ok: true } });
});

describe('LifecycleSuggestions queue', () => {
  it('lists each suggestion by name, with its successor by name and the source', async () => {
    renderQueue();

    const row = await screen.findByTestId('discovery-suggestion-row-gpt-sunset');
    await waitFor(() => expect(row).toHaveTextContent('GPT Sunset'));
    expect(row).toHaveTextContent('Deprecated');
    expect(row).toHaveTextContent('deprecates 2026-08-01');
    expect(row).toHaveTextContent('anthropic-docs');
    expect(screen.getByTestId('discovery-suggestion-successor-gpt-sunset')).toHaveTextContent('GPT Live');
  });

  it('opens the model when its row is activated', async () => {
    renderQueue();
    fireEvent.click(await screen.findByTestId('discovery-suggestion-row-gpt-sunset'));

    expect(m.nav.openModel).toHaveBeenCalledWith('gpt-sunset');
  });

  it('prices the suggested successor in the queue row', async () => {
    renderQueue();

    expect(await screen.findByTestId('successor-cost-chip-gpt-sunset')).toHaveTextContent('costs more +1100% (12.0x)');
  });

  it('marks the cost unpriced when the response carries no rates', async () => {
    lifecycle = { ...LIFECYCLE, perMTokRates: undefined };
    renderQueue();

    expect(await screen.findByTestId('successor-cost-chip-gpt-sunset')).toHaveTextContent('no price on file');
    await openMenuItem('accept');
    expect(screen.getByTestId('successor-cost-panel')).toHaveTextContent('no price on file');
  });

  it('says so when nothing is waiting for a decision', async () => {
    lifecycle = { ...LIFECYCLE, queue: [] };
    renderQueue();

    expect(await screen.findByTestId('discovery-suggestions-empty')).toHaveTextContent(
      'No lifecycle suggestions are waiting'
    );
  });

  it('shows the missing permission and fetches nothing without settings:manage', async () => {
    m.currentUser = SUPPORT_ONLY;
    renderQueue();

    expect(await screen.findByTestId('admin-missing-permission-state')).toBeInTheDocument();
    expect(lifecycleGets()).toBe(0);
  });

  it('shows the queue to a delegate but blocks the decision menu', async () => {
    m.currentUser = DELEGATE;
    renderQueue();

    const menu = await screen.findByTestId('discovery-suggestion-actions-gpt-sunset');
    expect(menu).toBeDisabled();
    expect(screen.getByTestId('models-write-blocked-action')).toContainElement(menu);
  });
});

describe('LifecycleSuggestions accept', () => {
  it('requires a reason, then posts it as the note with the suggested successor', async () => {
    renderQueue();
    await openMenuItem('accept');

    expect(confirm('accept')).toBeDisabled();
    expect(confirm('accept')).toHaveTextContent('Mark as deprecated');
    fireEvent.click(screen.getByTestId('discovery-accept-dialog-reason-input-preset-0'));
    fireEvent.click(confirm('accept'));

    await waitFor(() => expect(m.post).toHaveBeenCalledTimes(1));
    expect(m.post).toHaveBeenCalledWith(LIFECYCLE_PATH, {
      modelId: 'gpt-sunset',
      action: 'accept',
      note: 'Provider announced the deprecation',
      replacedBy: 'gpt-live',
    });
    await waitFor(() => expect(screen.queryByTestId('discovery-accept-dialog')).not.toBeInTheDocument());
    expect(m.toast.success).toHaveBeenCalledWith('Recorded GPT Sunset as deprecated.');
    expect(screen.queryByTestId('discovery-suggestion-row-gpt-sunset')).not.toBeInTheDocument();
    // Settled locally: a refetch would fan out to every provider again.
    expect(lifecycleGets()).toBe(1);
  });

  it('previews the change and names the successor', async () => {
    renderQueue();
    await screen.findByText('GPT Sunset');
    await openMenuItem('accept');

    expect(screen.getByTestId('discovery-accept-preview')).toHaveTextContent('Active');
    expect(screen.getByTestId('discovery-accept-preview')).toHaveTextContent('Deprecated');
    expect(screen.getByTestId('discovery-accept-successor-name')).toHaveTextContent('GPT Live');
  });

  it('sends an edited successor override instead of the suggested one', async () => {
    renderQueue();
    await openMenuItem('accept');
    typeSuccessor('gpt-newer');
    writeReason('accept', 'operator pick');
    fireEvent.click(confirm('accept'));

    await waitFor(() => expect(m.post).toHaveBeenCalledTimes(1));
    expect(m.post.mock.calls[0][1]).toMatchObject({ replacedBy: 'gpt-newer', note: 'operator pick' });
  });

  it('sends no successor when the field is cleared, and says the suggested one stays', async () => {
    renderQueue();
    await screen.findByText('GPT Sunset');
    await openMenuItem('accept');
    typeSuccessor('');

    expect(screen.getByTestId('discovery-accept-successor-name')).toHaveTextContent(
      'Left empty, GPT Live stays the successor.'
    );
    expect(screen.getByTestId('successor-cost-panel')).toHaveTextContent('costs more');
    writeReason('accept', 'operator pick');
    fireEvent.click(confirm('accept'));
    await waitFor(() => expect(m.post).toHaveBeenCalledTimes(1));
    expect(m.post.mock.calls[0][1]).not.toHaveProperty('replacedBy');
  });

  it('names the recorded successor when the suggestion carries none', async () => {
    const { replacedBy: _dropped, ...withoutSuccessor } = LIFECYCLE.queue[0].suggestion!;
    lifecycle = { ...LIFECYCLE, queue: [{ modelId: 'gpt-sunset', suggestion: withoutSuccessor }] };
    sunsetLifecycle = { replacedBy: 'gpt-newer' };
    renderQueue();
    await screen.findByText('GPT Sunset');
    await openMenuItem('accept');

    expect(screen.getByTestId('discovery-accept-successor-name')).toHaveTextContent(
      'Left empty, GPT Newer stays the successor.'
    );
  });

  it('says users are not moved only when no successor is suggested or recorded', async () => {
    const { replacedBy: _dropped, ...withoutSuccessor } = LIFECYCLE.queue[0].suggestion!;
    lifecycle = { ...LIFECYCLE, queue: [{ modelId: 'gpt-sunset', suggestion: withoutSuccessor }] };
    renderQueue();
    await screen.findByText('GPT Sunset');
    await openMenuItem('accept');

    expect(screen.getByTestId('discovery-accept-successor-name')).toHaveTextContent(
      'No successor: users of this model are not moved.'
    );
  });

  it('keeps the recorded status for a successor-only suggestion, as the server does', async () => {
    const { status: _dropped, ...remapOnly } = LIFECYCLE.queue[0].suggestion!;
    lifecycle = { ...LIFECYCLE, queue: [{ modelId: 'gpt-sunset', suggestion: remapOnly }] };
    sunsetLifecycle = { status: 'retired', retirementDate: '2026-09-01' };
    renderQueue();
    await screen.findByText('GPT Sunset');
    await openMenuItem('accept');

    const preview = screen.getByTestId('discovery-accept-preview');
    expect(preview).not.toHaveTextContent('Deprecated');
    expect(preview).toHaveTextContent('Retired');
    expect(screen.getByTestId('discovery-accept-dialog')).toHaveTextContent('Its lifecycle stays retired.');
    expect(screen.getByTestId('discovery-accept-dialog')).toHaveTextContent('retirement 2026-09-01');
    expect(confirm('accept')).toHaveTextContent('Accept change');

    writeReason('accept', 'operator pick');
    fireEvent.click(confirm('accept'));
    await waitFor(() => expect(m.toast.success).toHaveBeenCalledWith('Recorded GPT Sunset as retired.'));
  });

  it('reprices the accept panel against the typed successor, not the suggested one', async () => {
    renderQueue();
    await openMenuItem('accept');

    expect(screen.getByTestId('successor-cost-panel')).toHaveTextContent('costs more');
    typeSuccessor('gpt-newer');

    const panel = screen.getByTestId('successor-cost-panel');
    expect(panel).toHaveTextContent('no cost increase');
    expect(panel).toHaveTextContent('$0.300 to $0.100 / MTok (-67%)');
  });

  it('flags a typed successor with no price row rather than showing it as free', async () => {
    renderQueue();
    await openMenuItem('accept');
    typeSuccessor('gpt-unpriced');

    expect(screen.getByTestId('successor-cost-panel')).toHaveTextContent('no price on file');
    expect(screen.getByTestId('discovery-accept-successor-name')).toHaveTextContent('Not a model this console knows');
  });

  it('shows the run account of the suggestion in the dialog', async () => {
    lifecycle = {
      ...LIFECYCLE,
      queue: [
        {
          modelId: 'gpt-sunset',
          suggestion: {
            ...LIFECYCLE.queue[0].suggestion!,
            detail: 'the provider names gpt-live to replace gpt-sunset, but it costs more',
          },
        },
      ],
    };
    renderQueue();
    await openMenuItem('accept');

    expect(screen.getByTestId('discovery-accept-detail')).toHaveTextContent('but it costs more');
  });

  it('keeps a server validation message inside the open dialog, and drops it on cancel', async () => {
    m.post.mockRejectedValue(apiError(400, { error: 'replacedBy gpt-typo is unknown to the merged model list' }));
    renderQueue();
    await openMenuItem('accept');
    writeReason('accept', 'operator pick');
    fireEvent.click(confirm('accept'));

    expect(await screen.findByTestId('discovery-accept-error')).toHaveTextContent('unknown to the merged model');
    expect(screen.getByTestId('discovery-accept-dialog')).toBeInTheDocument();
    expect(m.toast.success).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('discovery-accept-dialog-cancel-btn'));
    await waitFor(() => expect(screen.queryByTestId('discovery-accept-error')).not.toBeInTheDocument());
    expect(screen.getByTestId('discovery-suggestion-row-gpt-sunset')).toBeInTheDocument();
  });

  it('turns a 409 into the blocker list plus an accept-anyway that sends the acknowledgement', async () => {
    m.post.mockRejectedValueOnce(
      apiError(409, {
        code: 'replacement-blocked',
        blockers: ['cost-not-lower'],
        details: ['it costs more than the model it would replace'],
      })
    );
    renderQueue();
    await openMenuItem('accept');
    writeReason('accept', 'operator pick');
    fireEvent.click(confirm('accept'));

    const blockers = await screen.findByTestId('discovery-accept-blockers');
    expect(blockers).toHaveTextContent('it costs more than the model it would replace');
    expect(screen.queryByTestId('discovery-accept-error')).not.toBeInTheDocument();
    expect(confirm('accept')).toHaveTextContent('Accept anyway');

    fireEvent.click(confirm('accept'));
    await waitFor(() => expect(m.post).toHaveBeenCalledTimes(2));
    expect(m.post.mock.calls[0][1]).not.toHaveProperty('acknowledgeBlockers');
    expect(m.post.mock.calls[1][1]).toMatchObject({ acknowledgeBlockers: true, replacedBy: 'gpt-live' });
    await waitFor(() => expect(screen.queryByTestId('discovery-accept-dialog')).not.toBeInTheDocument());
  });

  it('drops held blockers when a different successor is typed', async () => {
    m.post.mockRejectedValueOnce(apiError(409, { code: 'replacement-blocked', details: ['it is not active'] }));
    renderQueue();
    await openMenuItem('accept');
    writeReason('accept', 'operator pick');
    fireEvent.click(confirm('accept'));
    await screen.findByTestId('discovery-accept-blockers');

    typeSuccessor('gpt-newer');

    expect(screen.queryByTestId('discovery-accept-blockers')).not.toBeInTheDocument();
    fireEvent.click(confirm('accept'));
    await waitFor(() => expect(m.post).toHaveBeenCalledTimes(2));
    expect(m.post.mock.calls[1][1]).not.toHaveProperty('acknowledgeBlockers');
  });
});

describe('LifecycleSuggestions dismiss', () => {
  it('confirms before posting, and posts the reason with the dismiss', async () => {
    renderQueue();
    await openMenuItem('dismiss');

    expect(screen.getByTestId('discovery-dismiss-dialog')).toHaveTextContent('There is no undo.');
    expect(m.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('discovery-dismiss-dialog-reason-input-preset-1'));
    fireEvent.click(confirm('dismiss'));

    await waitFor(() => expect(m.post).toHaveBeenCalledTimes(1));
    expect(m.post).toHaveBeenCalledWith(LIFECYCLE_PATH, {
      modelId: 'gpt-sunset',
      action: 'dismiss',
      note: 'Model is still supported',
    });
    await waitFor(() => expect(screen.queryByTestId('discovery-suggestion-row-gpt-sunset')).not.toBeInTheDocument());
    expect(m.toast.success).toHaveBeenCalledWith('Dismissed the suggestion for GPT Sunset.');
  });

  it('posts nothing when cancelled', async () => {
    renderQueue();
    await openMenuItem('dismiss');
    fireEvent.click(screen.getByTestId('discovery-dismiss-dialog-cancel-btn'));

    expect(m.post).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId('discovery-dismiss-dialog')).not.toBeInTheDocument());
  });

  it('sends exactly one request for a double-clicked confirm', async () => {
    let settle = (_value: { data: Record<string, unknown> }) => {};
    m.post.mockReturnValue(new Promise(resolve => (settle = resolve)));
    renderQueue();
    await openMenuItem('dismiss');
    writeReason('dismiss', 'operator pick');

    fireEvent.click(confirm('dismiss'));
    fireEvent.click(confirm('dismiss'));
    settle({ data: {} });

    await waitFor(() => expect(screen.queryByTestId('discovery-dismiss-dialog')).not.toBeInTheDocument());
    expect(m.post).toHaveBeenCalledTimes(1);
  });

  it('keeps the dialog open with the server reason when the dismiss fails', async () => {
    m.post.mockRejectedValueOnce(apiError(400, { error: 'No pending suggestion for gpt-sunset' }));
    renderQueue();
    await openMenuItem('dismiss');
    writeReason('dismiss', 'operator pick');
    fireEvent.click(confirm('dismiss'));

    expect(await screen.findByTestId('discovery-dismiss-error')).toHaveTextContent('No pending suggestion');
    expect(screen.getByTestId('discovery-suggestion-row-gpt-sunset')).toBeInTheDocument();
  });
});
