import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

type BlockerOptions = { enableBeforeUnload: boolean };
const user = vi.hoisted(() => ({
  current: { isAdmin: true, adminPermissions: [] } as { isAdmin: boolean; adminPermissions?: string[] },
}));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: user.current }) }));
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  useBlocker: vi.fn<(options: BlockerOptions) => { status: string }>(() => ({ status: 'idle' })),
}));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: mocks.get, put: mocks.put, delete: mocks.del } }));
vi.mock('sonner', () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock('@tanstack/react-router', () => ({
  useBlocker: mocks.useBlocker,
  useRouter: () => ({
    state: { location: { pathname: '/admin', search: { tab: 'manage-gears' } } },
    navigate: vi.fn(),
  }),
}));

import ManageGearsTab from './ManageGearsTab';

const appTheme = extendTheme({ ...getThemeConfig() });

const defaults = (title: string) => ({
  credits: 500,
  enabled: true,
  title,
  tagline: `${title} tagline`,
  intro: `${title} intro`,
  cta: 'Try it',
  ctaAction: 'navigate:/notebooks',
});

const GEARS = [
  { key: 'websearch', kind: 'skill', defaults: defaults('Web search'), override: null },
  {
    key: 'files',
    kind: 'destination',
    defaults: defaults('Files'),
    override: {
      enabled: false,
      credits: 0,
      title: null,
      tagline: null,
      intro: null,
      cta: null,
      ctaAction: null,
      updatedBy: 'admin-1',
      updatedAt: '2026-11-01T00:00:00.000Z',
    },
  },
];

const saveResponse = (body: Record<string, unknown>) => ({
  data: { override: { ...body, updatedBy: 'admin-1', updatedAt: '2026-11-09T08:00:00.000Z' } },
});

const renderTab = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>
        <ManageGearsTab />
      </CssVarsProvider>
    </QueryClientProvider>
  );
};

const openRowMenu = (key: string) => fireEvent.click(screen.getByTestId(`manage-gear-actions-${key}`));
const startEditing = async (key: string) => {
  openRowMenu(key);
  fireEvent.click(await screen.findByTestId(`manage-gear-edit-${key}`));
  return screen.findByTestId(`manage-gear-credits-${key}`);
};

describe('ManageGearsTab', () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => mock.mockClear());
    user.current = { isAdmin: true, adminPermissions: [] };
    mocks.get.mockReset().mockResolvedValue({ data: { gears: GEARS } });
    mocks.put.mockReset().mockImplementation(async (_url: string, body: Record<string, unknown>) => saveResponse(body));
    mocks.del.mockReset().mockResolvedValue({ data: { ok: true } });
  });

  it('opens with the page header: a sentence-case h1 with no icon and a one-line description', async () => {
    renderTab();

    const header = screen.getByTestId('admin-page-header');
    expect(screen.getByTestId('manage-gears-tab').firstElementChild).toBe(header);
    const title = within(header).getByRole('heading', { level: 1 });
    expect(title).toHaveTextContent(/^Gears$/);
    expect(title.querySelector('svg')).toBeNull();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(header).toHaveTextContent('setting its credits to 0');
    await screen.findByTestId('manage-gear-row-websearch');
  });

  it('lists gears in one DataTable that scrolls sideways below its min width, with single-line keys', async () => {
    renderTab();
    await screen.findByTestId('manage-gear-row-websearch');

    expect(screen.getByTestId('manage-gears-table')).toHaveStyle({ minWidth: '62rem' });
    expect(screen.getByTestId('manage-gears-table-frame')).toBeInTheDocument();
    expect(screen.getByTestId('manage-gears-tab').querySelectorAll('.MuiCard-root')).toHaveLength(0);
    const key = screen.getByTestId('manage-gear-key-websearch');
    expect(key).toHaveAttribute('title', 'websearch');
    expect(getComputedStyle(key).whiteSpace).toBe('nowrap');
    expect(getComputedStyle(key).textOverflow).toBe('ellipsis');
  });

  it('tags the kind as a neutral status chip and an override as warn', async () => {
    renderTab();

    const kind = await screen.findByTestId('manage-gear-kind-files');
    expect(kind).toHaveTextContent('destination');
    expect(kind).toHaveAttribute('data-tone', 'neutral');
    expect(screen.getByTestId('manage-gear-overridden-files')).toHaveAttribute('data-tone', 'warn');
    expect(screen.queryByTestId('manage-gear-overridden-websearch')).toBeNull();
  });

  it('stages an edit for the page SaveBar, then sends the same sparse patch on Save', async () => {
    renderTab();
    await screen.findByTestId('manage-gear-row-websearch');

    expect(screen.queryByTestId('admin-save-bar')).toBeNull();
    const credits = await startEditing('websearch');
    expect(screen.queryByTestId('manage-gear-save-websearch')).toBeNull();
    fireEvent.change(credits, { target: { value: '250' } });
    fireEvent.change(screen.getByTestId('manage-gear-title-websearch'), { target: { value: 'Search harder' } });

    expect(screen.getByTestId('admin-save-bar')).toHaveTextContent('1 unsaved change');
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.useBlocker.mock.lastCall?.[0].enableBeforeUnload).toBe(true);

    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));

    await waitFor(() => expect(mocks.put).toHaveBeenCalledTimes(1));
    expect(mocks.put).toHaveBeenCalledWith('/api/admin/gears', {
      key: 'websearch',
      enabled: null,
      credits: 250,
      title: 'Search harder',
      tagline: null,
      intro: null,
      cta: null,
      ctaAction: null,
    });
    await waitFor(() => expect(screen.queryByTestId('admin-save-bar')).toBeNull());
    expect(screen.queryByTestId('manage-gear-credits-websearch')).toBeNull();
    expect(mocks.success).toHaveBeenCalledWith('Saved override for "websearch" - live now');
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('manage-gear-row-websearch')).toHaveTextContent('Search harder');
    expect(screen.getByTestId('manage-gear-row-websearch')).toHaveTextContent('250');
  });

  it('updates each saved gear from the PUT response without refetching the list for each draft', async () => {
    renderTab();
    await screen.findByTestId('manage-gear-row-websearch');

    fireEvent.change(await startEditing('websearch'), { target: { value: '100' } });
    await startEditing('files');
    fireEvent.click(within(screen.getByTestId('manage-gear-enabled-files')).getByRole('switch'));

    expect(screen.getByTestId('admin-save-bar')).toHaveTextContent('2 unsaved changes');
    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));

    await waitFor(() => expect(mocks.put).toHaveBeenCalledTimes(2));
    expect(mocks.put.mock.calls.map(call => call[1])).toEqual([
      expect.objectContaining({ key: 'websearch', credits: 100, enabled: null }),
      expect.objectContaining({ key: 'files', credits: 0, enabled: null }),
    ]);
    await waitFor(() => expect(screen.queryByTestId('admin-save-bar')).toBeNull());
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('manage-gear-row-websearch')).toHaveTextContent('100');
    expect(await startEditing('files')).toHaveValue('0');
  });

  it('disables row commands while a save is in flight', async () => {
    const request = Promise.withResolvers<ReturnType<typeof saveResponse>>();
    mocks.put.mockReturnValueOnce(request.promise);
    renderTab();
    await screen.findByTestId('manage-gear-row-files');
    fireEvent.change(await startEditing('files'), { target: { value: '10' } });
    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));
    await waitFor(() => expect(mocks.put).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('manage-gear-actions-files')).toBeDisabled();
    expect(screen.getByTestId('manage-gear-credits-files')).toBeDisabled();
    expect(mocks.del).not.toHaveBeenCalled();
    await act(async () => {
      request.resolve(saveResponse({ credits: 10 }));
    });
    await waitFor(() => expect(screen.queryByTestId('admin-save-bar')).toBeNull());
  });

  it('disables the SaveBar while a reset is in flight', async () => {
    const request = Promise.withResolvers<{ data: { ok: boolean } }>();
    mocks.del.mockReturnValueOnce(request.promise);
    renderTab();
    await screen.findByTestId('manage-gear-row-files');
    fireEvent.change(await startEditing('files'), { target: { value: '10' } });
    openRowMenu('files');
    fireEvent.click(await screen.findByTestId('manage-gear-reset-files'));
    expect(mocks.del).not.toHaveBeenCalled();
    const dialog = await screen.findByTestId('manage-gear-reset-dialog-files');
    fireEvent.change(within(dialog).getByTestId('manage-gear-reset-dialog-files-reason-input'), {
      target: { value: 'Restore the code defaults' },
    });
    fireEvent.click(within(dialog).getByTestId('manage-gear-reset-dialog-files-confirm-btn'));
    await waitFor(() => expect(mocks.del).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('admin-save-confirm-btn')).toBeDisabled();
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    expect(within(dialog).getByTestId('manage-gear-reset-dialog-files-confirm-btn')).toBeDisabled();
    expect(screen.getByTestId('admin-save-bar')).toHaveTextContent('1 unsaved change');
    expect(mocks.put).not.toHaveBeenCalled();
    await act(async () => {
      request.resolve({ data: { ok: true } });
    });
    await waitFor(() => expect(screen.queryByTestId('admin-save-bar')).toBeNull());
  });

  it('discards every staged edit back to the loaded values without a request', async () => {
    renderTab();
    await screen.findByTestId('manage-gear-row-websearch');

    fireEvent.change(await startEditing('websearch'), { target: { value: '9' } });
    fireEvent.click(screen.getByTestId('admin-save-discard-btn'));

    expect(screen.queryByTestId('admin-save-bar')).toBeNull();
    expect(screen.getByTestId('manage-gear-credits-websearch')).toHaveValue('500');
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it('blocks Save and says why while a gear has invalid credits', async () => {
    renderTab();
    await screen.findByTestId('manage-gear-row-websearch');

    fireEvent.change(await startEditing('websearch'), { target: { value: '-5' } });

    const bar = screen.getByTestId('admin-save-bar');
    expect(bar).toHaveTextContent('websearch: Credits must be a non-negative integer');
    expect(screen.getByTestId('admin-save-confirm-btn')).toBeDisabled();
    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it.each(['', ' ', '-1', '1.5', '1000001', 'Infinity', 'bad'])(
    'blocks invalid credits %j without writing',
    async credits => {
      renderTab();
      await screen.findByTestId('manage-gear-row-websearch');
      fireEvent.change(await startEditing('websearch'), { target: { value: credits } });
      expect(screen.getByTestId('admin-save-confirm-btn')).toBeDisabled();
      expect(mocks.put).not.toHaveBeenCalled();
    }
  );

  it.each(['0', '1000000'])('saves valid boundary credits %s', async credits => {
    renderTab();
    await screen.findByTestId('manage-gear-row-websearch');
    fireEvent.change(await startEditing('websearch'), { target: { value: credits } });
    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));
    await waitFor(() => expect(screen.queryByTestId('admin-save-bar')).toBeNull());
    expect(mocks.put).toHaveBeenCalledWith('/api/admin/gears', expect.objectContaining({ credits: Number(credits) }));
    expect(await startEditing('websearch')).toHaveValue(credits);
  });

  it('resets an overridden gear from its row menu with the same DELETE', async () => {
    renderTab();
    await screen.findByTestId('manage-gear-row-files');

    openRowMenu('websearch');
    expect(await screen.findByTestId('manage-gear-edit-websearch')).toBeInTheDocument();
    expect(screen.queryByTestId('manage-gear-reset-websearch')).toBeNull();
    fireEvent.keyDown(screen.getByTestId('manage-gear-edit-websearch'), { key: 'Escape' });

    openRowMenu('files');
    fireEvent.click(await screen.findByTestId('manage-gear-reset-files'));
    expect(mocks.del).not.toHaveBeenCalled();
    const dialog = await screen.findByTestId('manage-gear-reset-dialog-files');
    fireEvent.change(within(dialog).getByTestId('manage-gear-reset-dialog-files-reason-input'), {
      target: { value: 'Restore the code defaults' },
    });
    fireEvent.click(within(dialog).getByTestId('manage-gear-reset-dialog-files-confirm-btn'));

    await waitFor(() => expect(mocks.del).toHaveBeenCalledTimes(1));
    expect(mocks.del).toHaveBeenCalledWith('/api/admin/gears/files');
    await waitFor(() => expect(mocks.success).toHaveBeenCalledWith('"files" reset to code defaults'));
  });

  it('keeps code defaults after a successful reset even when the following refresh fails', async () => {
    renderTab();
    await screen.findByTestId('manage-gear-row-files');
    mocks.get.mockRejectedValueOnce(new Error('network down'));
    openRowMenu('files');
    fireEvent.click(await screen.findByTestId('manage-gear-reset-files'));
    expect(mocks.del).not.toHaveBeenCalled();
    const dialog = await screen.findByTestId('manage-gear-reset-dialog-files');
    fireEvent.change(within(dialog).getByTestId('manage-gear-reset-dialog-files-reason-input'), {
      target: { value: 'Restore the code defaults' },
    });
    fireEvent.click(within(dialog).getByTestId('manage-gear-reset-dialog-files-confirm-btn'));
    await screen.findByTestId('manage-gears-refresh-error');
    expect(screen.queryByTestId('manage-gear-overridden-files')).toBeNull();
    expect(await startEditing('files')).toHaveValue('500');
    expect(within(screen.getByTestId('manage-gear-enabled-files')).getByRole('switch')).toBeChecked();
  });

  it('shows table skeleton rows on the first load, under the header', async () => {
    mocks.get.mockReturnValue(new Promise(() => {}));
    renderTab();

    expect(screen.getByTestId('admin-page-header')).toBeInTheDocument();
    expect((await screen.findAllByTestId('admin-table-skeleton-row')).length).toBeGreaterThan(0);
  });

  it('shows an ErrorState with Try again when the list fails to load', async () => {
    mocks.get.mockRejectedValueOnce(new Error('network down'));
    renderTab();

    const error = await screen.findByTestId('admin-error-state');
    expect(error).toHaveTextContent('Could not load gears.');
    fireEvent.click(within(error).getByTestId('admin-error-retry-btn'));
    expect(await screen.findByTestId('manage-gear-row-websearch')).toBeInTheDocument();
  });

  it('keeps a gear that failed to save in edit mode with its draft, after saving the ones before it', async () => {
    mocks.put
      .mockImplementationOnce(async (_url: string, body: Record<string, unknown>) => saveResponse(body))
      .mockRejectedValueOnce(new Error('Invalid ctaAction'));
    renderTab();
    await screen.findByTestId('manage-gear-row-websearch');

    fireEvent.change(await startEditing('websearch'), { target: { value: '100' } });
    fireEvent.change(await startEditing('files'), { target: { value: '7' } });
    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));

    await waitFor(() => expect(screen.getByTestId('admin-save-bar')).toHaveTextContent('files was not saved'));
    expect(screen.getByTestId('admin-save-bar')).toHaveTextContent('Invalid ctaAction');
    expect(screen.getByTestId('admin-save-bar')).toHaveTextContent('1 unsaved change');
    expect(mocks.put).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('manage-gear-credits-websearch')).toBeNull();
    expect(screen.getByTestId('manage-gear-credits-files')).toHaveValue('7');
    expect(screen.getByTestId('manage-gear-row-websearch')).toHaveTextContent('100');
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it('drops the row draft on Cancel editing', async () => {
    renderTab();
    await screen.findByTestId('manage-gear-row-websearch');

    fireEvent.change(await startEditing('websearch'), { target: { value: '42' } });
    expect(screen.getByTestId('admin-save-bar')).toBeInTheDocument();
    openRowMenu('websearch');
    fireEvent.click(await screen.findByTestId('manage-gear-cancel-websearch'));

    expect(screen.queryByTestId('admin-save-bar')).toBeNull();
    expect(screen.queryByTestId('manage-gear-credits-websearch')).toBeNull();
    expect(screen.getByTestId('manage-gear-row-websearch')).toHaveTextContent('500');
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it('clears a staged edit on the gear it resets', async () => {
    renderTab();
    await screen.findByTestId('manage-gear-row-files');

    fireEvent.change(await startEditing('files'), { target: { value: '9' } });
    expect(screen.getByTestId('admin-save-bar')).toBeInTheDocument();
    openRowMenu('files');
    fireEvent.click(await screen.findByTestId('manage-gear-reset-files'));
    expect(mocks.del).not.toHaveBeenCalled();
    const dialog = await screen.findByTestId('manage-gear-reset-dialog-files');
    fireEvent.change(within(dialog).getByTestId('manage-gear-reset-dialog-files-reason-input'), {
      target: { value: 'Restore the code defaults' },
    });
    fireEvent.click(within(dialog).getByTestId('manage-gear-reset-dialog-files-confirm-btn'));

    await waitFor(() => expect(mocks.del).toHaveBeenCalledWith('/api/admin/gears/files'));
    await waitFor(() => expect(screen.queryByTestId('admin-save-bar')).toBeNull());
    expect(mocks.put).not.toHaveBeenCalled();
  });
});

describe('ManageGearsTab write controls', () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => mock.mockClear());
    mocks.get.mockReset().mockResolvedValue({ data: { gears: GEARS } });
  });

  it('disables the edit and reset menu for a support:read delegate', async () => {
    user.current = { isAdmin: false, adminPermissions: ['support:read'] };
    renderTab();
    await screen.findByTestId('manage-gear-row-files');

    for (const key of ['websearch', 'files']) {
      expect(screen.getByTestId(`manage-gear-actions-${key}`)).toBeDisabled();
    }
    expect(screen.getAllByTestId('admin-missing-permission-action')).toHaveLength(2);
    openRowMenu('files');
    expect(screen.queryByTestId('manage-gear-edit-files')).toBeNull();
    expect(screen.queryByTestId('manage-gear-reset-files')).toBeNull();
  });

  it('enables edit and reset for a settings:manage delegate', async () => {
    user.current = { isAdmin: false, adminPermissions: ['settings:manage'] };
    renderTab();
    await screen.findByTestId('manage-gear-row-files');

    expect(screen.queryByTestId('admin-missing-permission-action')).toBeNull();
    openRowMenu('files');
    expect(await screen.findByTestId('manage-gear-edit-files')).not.toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('manage-gear-reset-files')).not.toHaveAttribute('aria-disabled', 'true');
  });
});
