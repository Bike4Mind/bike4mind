import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
import { LIFECYCLE_QUEUE_QUERY_KEY, STALE_REFERENCES_QUERY_KEY, type LifecycleStatus } from './discoveryApi';

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
const QUEUE_VIEW = { params: { view: 'queue' } };

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

const typeDismissId = (value = 'gpt-sunset') =>
  fireEvent.change(screen.getByTestId('discovery-dismiss-dialog-typed-input'), { target: { value } });

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
          adminRow('anthropic.claude-v2', { name: 'Claude v2', backend: 'bedrock' }),
          adminRow('house-model', { name: 'House Model', backend: 'gemini' }),
        ]),
      };
    }
    throw new Error(`unexpected GET ${url}`);
  });
  // The server drops a settled suggestion from the queue it answers next.
  m.post.mockImplementation(async (_url: string, body: { modelId: string }) => {
    lifecycle = { ...lifecycle, queue: lifecycle.queue.filter(item => item.modelId !== body.modelId) };
    return { data: { ok: true } };
  });
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

  it('keeps the loaded queue with a warning when a refresh fails', async () => {
    renderQueue();
    await screen.findByTestId('discovery-suggestion-row-gpt-sunset');

    m.get.mockRejectedValueOnce(apiError(500, { error: 'Database unavailable' }));
    await queryClient.refetchQueries({ queryKey: LIFECYCLE_QUEUE_QUERY_KEY });

    expect(await screen.findByTestId('discovery-suggestions-refresh-error')).toHaveTextContent('Database unavailable');
    expect(screen.getByTestId('discovery-suggestion-row-gpt-sunset')).toBeInTheDocument();
  });

  it('shows the missing permission and fetches nothing without settings:manage', async () => {
    m.currentUser = SUPPORT_ONLY;
    renderQueue();

    expect(await screen.findByTestId('admin-missing-permission-state')).toBeInTheDocument();
    expect(lifecycleGets()).toBe(0);
  });

  it('loads the queue through view=queue, so opening it asks no provider', async () => {
    renderQueue();
    await screen.findByTestId('discovery-suggestion-row-gpt-sunset');

    expect(m.get.mock.calls.filter(([url]) => url === LIFECYCLE_PATH)).toEqual([[LIFECYCLE_PATH, QUEUE_VIEW]]);
  });

  it('resyncs the queue from the server after a decision, still through view=queue', async () => {
    renderQueue();
    await openMenuItem('dismiss');
    writeReason('dismiss', 'operator pick');
    typeDismissId();
    fireEvent.click(confirm('dismiss'));

    await waitFor(() => expect(lifecycleGets()).toBe(2));
    expect(m.get.mock.calls.filter(([url]) => url === LIFECYCLE_PATH)[1]).toEqual([LIFECYCLE_PATH, QUEUE_VIEW]);
  });

  it('links to the price catalog from the header', async () => {
    renderQueue();
    fireEvent.click(await screen.findByTestId('discovery-suggestions-prices-link'));

    expect(m.nav.openPrices).toHaveBeenCalledWith();
  });

  it('shows the queue to a delegate but blocks the decision menu', async () => {
    m.currentUser = DELEGATE;
    renderQueue();

    const menu = await screen.findByTestId('discovery-suggestion-actions-gpt-sunset');
    expect(menu).toBeDisabled();
    expect(screen.getByTestId('models-write-blocked-action')).toContainElement(menu);
  });

  it('leaves the selection column room of its own', async () => {
    renderQueue();

    expect(await screen.findByTestId('discovery-suggestions-table')).toHaveStyle({ minWidth: '43rem' });
  });
});

describe('LifecycleSuggestions accept', () => {
  const acceptWith = async (suggestion: Partial<NonNullable<LifecycleStatus['queue'][number]['suggestion']>>) => {
    lifecycle = {
      ...LIFECYCLE,
      queue: [{ modelId: 'gpt-sunset', suggestion: { ...LIFECYCLE.queue[0].suggestion!, ...suggestion } }],
    };
    renderQueue();
    await screen.findByText('GPT Sunset');
    await openMenuItem('accept');
    return screen.getByTestId('discovery-accept-dialog');
  };

  it('says a retired model leaves every picker now', async () => {
    const dialog = await acceptWith({ status: 'retired', deprecationDate: undefined });

    expect(dialog).toHaveTextContent('Records GPT Sunset as retired, effective now. It leaves every picker now.');
  });

  it('says a deprecated model with a date drops out of pickers after it', async () => {
    const dialog = await acceptWith({ status: 'deprecated', deprecationDate: '2026-08-01' });

    expect(dialog).toHaveTextContent('It drops out of pickers after 2026-08-01.');
  });

  it('says a deprecated model with no date stays in pickers', async () => {
    const dialog = await acceptWith({ status: 'deprecated', deprecationDate: undefined });

    expect(dialog).toHaveTextContent('It stays in pickers until a date is set.');
    expect(dialog).not.toHaveTextContent('drops out');
  });

  it('prefills the reason with an evidence line built from the suggestion', async () => {
    renderQueue();
    await screen.findByText('GPT Sunset');
    await openMenuItem('accept');

    const note = screen.getByTestId('discovery-accept-dialog-reason-input') as HTMLTextAreaElement;
    expect(note.value).toBe(
      'OpenAI deprecations page (https://developers.openai.com/api/docs/deprecations): Deprecated 2026-08-01. ' +
        'Signal: anthropic-docs signal.'
    );
    expect(confirm('accept')).toBeEnabled();

    fireEvent.click(screen.getByTestId('discovery-accept-dialog-reason-input-preset-0'));
    fireEvent.click(confirm('accept'));
    await waitFor(() => expect(m.post).toHaveBeenCalledTimes(1));
    expect(m.post.mock.calls[0][1]).toMatchObject({ note: `Confirmed on the vendor page: ${note.value}` });
  });

  it('takes the vendor page for the evidence line from the model index', async () => {
    lifecycle = {
      ...LIFECYCLE,
      queue: [{ modelId: 'house-model', missCount: 3, suggestion: { source: 'absence', suggestedAt: '2026-07-20' } }],
    };
    renderQueue();
    await screen.findByText('House Model');
    await openMenuItem('accept', 'house-model');

    expect(screen.getByTestId('discovery-accept-dialog-reason-input')).toHaveValue(
      'Google AI Studio deprecations page (https://aistudio.google.com/docs/deprecations): no dates given. ' +
        'Signal: absent from the provider model list for 3 runs.'
    );
  });

  it('requires a reason, then posts it as the note with the suggested successor', async () => {
    renderQueue();
    await openMenuItem('accept');

    // The prefill is a draft: emptying it blocks the accept, because the reason is the audit trail.
    writeReason('accept', '  ');
    expect(confirm('accept')).toBeDisabled();
    expect(confirm('accept')).toHaveTextContent('Mark as deprecated');
    fireEvent.click(screen.getByTestId('discovery-accept-dialog-reason-input-preset-0'));
    fireEvent.click(confirm('accept'));

    await waitFor(() => expect(m.post).toHaveBeenCalledTimes(1));
    expect(m.post).toHaveBeenCalledWith(LIFECYCLE_PATH, {
      modelId: 'gpt-sunset',
      action: 'accept',
      note: 'Confirmed on the vendor page',
      replacedBy: 'gpt-live',
    });
    await waitFor(() => expect(screen.queryByTestId('discovery-accept-dialog')).not.toBeInTheDocument());
    expect(m.toast.success).toHaveBeenCalledWith('Recorded GPT Sunset as deprecated.');
    expect(screen.queryByTestId('discovery-suggestion-row-gpt-sunset')).not.toBeInTheDocument();
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
    // The route records a dismiss reason in its audit entry.
    expect(screen.getByTestId('discovery-dismiss-dialog-reason-input-helper')).toHaveTextContent(
      'Recorded in the audit log.'
    );
    expect(m.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('discovery-dismiss-dialog-reason-input-preset-1'));
    expect(confirm('dismiss')).toBeDisabled();
    typeDismissId('gpt-sunse');
    expect(confirm('dismiss')).toBeDisabled();
    typeDismissId();
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
    typeDismissId();

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
    typeDismissId();
    fireEvent.click(confirm('dismiss'));

    expect(await screen.findByTestId('discovery-dismiss-error')).toHaveTextContent('No pending suggestion');
    expect(screen.getByTestId('discovery-suggestion-row-gpt-sunset')).toBeInTheDocument();
  });
});

describe('LifecycleSuggestions bulk settle', () => {
  const BEDROCK_ITEM = {
    modelId: 'anthropic.claude-v2',
    suggestion: {
      status: 'deprecated',
      deprecationDate: '2026-09-30',
      retirementDate: '2027-03-30',
      source: 'litellm',
      suggestedAt: '2026-11-01T00:00:00.000Z',
    },
  };

  const selectRows = async (...modelIds: string[]) => {
    for (const modelId of modelIds) {
      // The test id sits on the Joy root; the click has to reach the input inside it.
      fireEvent.click(within(await screen.findByTestId(`admin-table-select-${modelId}`)).getByRole('checkbox'));
    }
  };

  const bulkConfirm = () => screen.getByTestId('discovery-bulk-dialog-confirm-btn');

  beforeEach(() => {
    lifecycle = { ...LIFECYCLE, queue: [...LIFECYCLE.queue, BEDROCK_ITEM] };
  });

  it('accepts every selected row with one shared, template-filled reason', async () => {
    renderQueue();
    await screen.findByText('Claude v2');
    await selectRows('anthropic.claude-v2');
    fireEvent.click(screen.getByTestId('discovery-bulk-accept-btn'));

    const dialog = screen.getByTestId('discovery-bulk-dialog');
    expect(screen.getByTestId('discovery-bulk-models')).toHaveTextContent(
      'Claude v2 - Deprecated, deprecates 2026-09-30, retires 2027-03-30'
    );
    const note = screen.getByTestId('discovery-bulk-dialog-reason-input') as HTMLTextAreaElement;
    expect(note.value).toContain('AWS Bedrock legacy page');
    expect(note.value).toContain('Legacy 2026-09-30, EOL 2027-03-30');
    expect(bulkConfirm()).toHaveTextContent('Accept 1 change');
    expect(dialog).toHaveTextContent('skipped and listed for a decision of its own');

    fireEvent.click(bulkConfirm());

    await waitFor(() => expect(m.post).toHaveBeenCalledTimes(1));
    expect(m.post).toHaveBeenCalledWith(LIFECYCLE_PATH, {
      modelId: 'anthropic.claude-v2',
      action: 'accept',
      note: note.value.trim(),
    });
    // Everything settled: the dialog closes, the queue reloads and the selection clears.
    await waitFor(() => expect(screen.queryByTestId('discovery-bulk-dialog')).not.toBeInTheDocument());
    expect(m.toast.success).toHaveBeenCalledWith('Accepted 1 lifecycle change.');
    await waitFor(() => expect(lifecycleGets()).toBe(2));
    expect(screen.queryByTestId('admin-bulk-action-bar')).not.toBeInTheDocument();
    expect(screen.queryByTestId('discovery-suggestion-row-anthropic.claude-v2')).not.toBeInTheDocument();
  });

  it('will not bulk accept with an emptied reason', async () => {
    renderQueue();
    await selectRows('gpt-sunset', 'anthropic.claude-v2');
    fireEvent.click(screen.getByTestId('discovery-bulk-accept-btn'));
    fireEvent.change(screen.getByTestId('discovery-bulk-dialog-reason-input'), { target: { value: ' ' } });

    expect(bulkConfirm()).toBeDisabled();
  });

  it('shows progress while the run is in flight and holds the dialog open', async () => {
    const pending: Array<(value: { data: Record<string, unknown> }) => void> = [];
    m.post.mockImplementation(() => new Promise(resolve => pending.push(resolve)));
    renderQueue();
    await selectRows('gpt-sunset', 'anthropic.claude-v2');
    fireEvent.click(screen.getByTestId('discovery-bulk-accept-btn'));
    fireEvent.click(bulkConfirm());

    expect(await screen.findByTestId('discovery-bulk-progress')).toHaveTextContent('0 of 2 done');
    expect(screen.getByTestId('discovery-bulk-dialog-cancel-btn')).toBeDisabled();
    pending[0]({ data: {} });
    await waitFor(() => expect(screen.getByTestId('discovery-bulk-progress')).toHaveTextContent('1 of 2 done'));
    // One request at a time: the second goes only after the first answered.
    expect(m.post).toHaveBeenCalledTimes(2);
    pending[1]({ data: {} });

    await waitFor(() => expect(screen.queryByTestId('discovery-bulk-dialog')).not.toBeInTheDocument());
    expect(m.toast.success).toHaveBeenCalledWith('Accepted 2 lifecycle changes.');
  });

  it('reports a replacement-blocked row back and hands it to the single-row dialog', async () => {
    m.post.mockImplementation(async (_url: string, body: { modelId: string }) => {
      if (body.modelId === 'gpt-sunset') {
        throw apiError(409, { code: 'replacement-blocked', details: ['costs more than gpt-sunset'] });
      }
      lifecycle = { ...lifecycle, queue: lifecycle.queue.filter(item => item.modelId !== body.modelId) };
      return { data: {} };
    });
    renderQueue();
    await selectRows('gpt-sunset', 'anthropic.claude-v2');
    fireEvent.click(screen.getByTestId('discovery-bulk-accept-btn'));
    fireEvent.click(bulkConfirm());

    const result = await screen.findByTestId('discovery-bulk-result-gpt-sunset');
    expect(result).toHaveTextContent('Needs its own decision');
    expect(result).toHaveTextContent('costs more than gpt-sunset');
    expect(screen.getByTestId('discovery-bulk-summary')).toHaveTextContent('1 of 2 accepted');
    expect(screen.queryByTestId('discovery-bulk-result-anthropic.claude-v2')).not.toBeInTheDocument();
    // Never auto-acknowledged: one request per row, none overruling.
    expect(m.post).toHaveBeenCalledTimes(2);
    for (const [, body] of m.post.mock.calls) expect(body).not.toHaveProperty('acknowledgeBlockers');
    // The blocked row stays selected for the next pass.
    expect(screen.getByTestId('admin-bulk-action-bar')).toHaveTextContent('1 selected');

    fireEvent.click(screen.getByTestId('discovery-bulk-review-gpt-sunset'));
    expect(await screen.findByTestId('discovery-accept-dialog')).toHaveTextContent('GPT Sunset');
    // The blockers the run already got are listed, and the override is offered without a first refusal.
    expect(screen.getByTestId('discovery-accept-blockers')).toHaveTextContent('costs more than gpt-sunset');
    expect(screen.getByTestId('discovery-accept-dialog-confirm-btn')).toHaveTextContent('Accept anyway');
  });

  it('keeps the plain accept dialog free of blockers when opened from the row menu', async () => {
    renderQueue();
    await openMenuItem('accept');
    expect(screen.queryByTestId('discovery-accept-blockers')).not.toBeInTheDocument();
    expect(confirm('accept')).not.toHaveTextContent('Accept anyway');
  });

  it('refetches the queue after a bulk run where every row failed, and drops vanished rows from the selection', async () => {
    m.post.mockImplementation(async () => {
      throw apiError(400, { error: 'already dismissed' });
    });
    renderQueue();
    await selectRows('gpt-sunset', 'anthropic.claude-v2');
    const before = lifecycleGets();
    // Another admin settled both meanwhile.
    lifecycle = {
      ...lifecycle,
      queue: lifecycle.queue.filter(item => !['gpt-sunset', 'anthropic.claude-v2'].includes(item.modelId)),
    };
    fireEvent.click(screen.getByTestId('discovery-bulk-accept-btn'));
    fireEvent.click(bulkConfirm());

    await waitFor(() => expect(lifecycleGets()).toBe(before + 1));
    await waitFor(() => expect(screen.queryByTestId('discovery-suggestion-row-gpt-sunset')).not.toBeInTheDocument());
    expect(screen.queryByTestId('admin-bulk-action-bar')).not.toBeInTheDocument();
  });

  it('re-runs a loaded reference report after a bulk accept, and never starts an unloaded one', async () => {
    renderQueue();
    await selectRows('gpt-sunset');
    fireEvent.click(screen.getByTestId('discovery-bulk-accept-btn'));
    fireEvent.click(bulkConfirm());
    await waitFor(() => expect(m.post).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(lifecycleGets()).toBe(2));
    expect(m.get.mock.calls.filter(([url, config]) => url === LIFECYCLE_PATH && !config)).toHaveLength(0);

    queryClient.setQueryData(STALE_REFERENCES_QUERY_KEY, { ...LIFECYCLE, staleReferences: [] });
    await selectRows('anthropic.claude-v2');
    fireEvent.click(screen.getByTestId('discovery-bulk-accept-btn'));
    fireEvent.click(bulkConfirm());
    await waitFor(() =>
      expect(m.get.mock.calls.filter(([url, config]) => url === LIFECYCLE_PATH && !config)).toHaveLength(1)
    );
  });

  it("lists a failed row with the server's message", async () => {
    m.post.mockImplementation(async (_url: string, body: { modelId: string }) => {
      if (body.modelId === 'gpt-sunset')
        throw apiError(400, { error: "gpt-sunset's suggestion was already dismissed" });
      lifecycle = { ...lifecycle, queue: lifecycle.queue.filter(item => item.modelId !== body.modelId) };
      return { data: {} };
    });
    renderQueue();
    await selectRows('gpt-sunset', 'anthropic.claude-v2');
    fireEvent.click(screen.getByTestId('discovery-bulk-dismiss-btn'));
    fireEvent.click(screen.getByTestId('discovery-bulk-dialog-reason-input-preset-0'));
    fireEvent.change(screen.getByTestId('discovery-bulk-dialog-typed-input'), { target: { value: '2' } });
    fireEvent.click(bulkConfirm());

    const result = await screen.findByTestId('discovery-bulk-result-gpt-sunset');
    expect(result).toHaveTextContent('Failed');
    expect(result).toHaveTextContent('already dismissed');
    expect(screen.queryByTestId('discovery-bulk-review-gpt-sunset')).not.toBeInTheDocument();
    expect(m.toast.success).toHaveBeenCalledWith('Dismissed 1 suggestion.');

    fireEvent.click(screen.getByTestId('discovery-bulk-result-dismiss-btn'));
    expect(screen.queryByTestId('discovery-bulk-result')).not.toBeInTheDocument();
  });

  it('dismisses the selection with a reason after the count is typed', async () => {
    renderQueue();
    await selectRows('gpt-sunset', 'anthropic.claude-v2');
    fireEvent.click(screen.getByTestId('discovery-bulk-dismiss-btn'));

    expect(screen.getByTestId('discovery-bulk-dialog')).toHaveTextContent('There is no undo.');
    expect(screen.getByTestId('discovery-bulk-dialog-reason-input')).toHaveValue('');
    expect(bulkConfirm()).toBeDisabled();
    fireEvent.click(screen.getByTestId('discovery-bulk-dialog-reason-input-preset-1'));
    expect(bulkConfirm()).toBeDisabled();
    fireEvent.change(screen.getByTestId('discovery-bulk-dialog-typed-input'), { target: { value: '2' } });
    expect(bulkConfirm()).toHaveTextContent('Dismiss 2 suggestions');
    fireEvent.click(bulkConfirm());

    await waitFor(() => expect(m.post).toHaveBeenCalledTimes(2));
    expect(m.post.mock.calls.map(([, body]) => body)).toEqual([
      { modelId: 'gpt-sunset', action: 'dismiss', note: 'Model is still supported' },
      { modelId: 'anthropic.claude-v2', action: 'dismiss', note: 'Model is still supported' },
    ]);
    await waitFor(() => expect(m.toast.success).toHaveBeenCalledWith('Dismissed 2 suggestions.'));
  });

  it('drops a row settled in its own dialog from the selected count', async () => {
    renderQueue();
    await selectRows('gpt-sunset', 'anthropic.claude-v2');
    expect(screen.getByTestId('admin-bulk-action-bar')).toHaveTextContent('2 selected');

    await openMenuItem('dismiss');
    writeReason('dismiss', 'operator pick');
    typeDismissId();
    fireEvent.click(confirm('dismiss'));

    await waitFor(() => expect(screen.getByTestId('admin-bulk-action-bar')).toHaveTextContent('1 selected'));
  });

  it('blocks selection and bulk settle for a delegate', async () => {
    m.currentUser = DELEGATE;
    renderQueue();

    const checkbox = within(await screen.findByTestId('admin-table-select-gpt-sunset')).getByRole('checkbox');
    expect(checkbox).toBeDisabled();
    expect(within(screen.getByTestId('admin-table-select-page')).getByRole('checkbox')).toBeDisabled();
    expect(screen.queryByTestId('admin-bulk-action-bar')).not.toBeInTheDocument();
  });
});
