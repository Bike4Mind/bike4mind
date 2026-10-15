import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AxiosError, type AxiosResponse } from 'axios';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IntegrationDemand, IntegrationRequester } from '@bike4mind/common';

// The hooks are mocked rather than axios, so each render path is driven directly; the routes
// behind them are covered by pages/api/admin/integrations/demand/__tests__/demand.e2e.test.ts.
const m = vi.hoisted(() => ({
  useIntegrationDemand: vi.fn(),
  useIntegrationRequesters: vi.fn(),
  fetchAllRequesterEmails: vi.fn(),
  toast: { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));
// Only the data-fetching hooks are replaced; the constants and the 429 check stay real.
vi.mock('@client/app/hooks/data/integrationDemand', async importOriginal => ({
  ...(await importOriginal<typeof import('@client/app/hooks/data/integrationDemand')>()),
  useIntegrationDemand: m.useIntegrationDemand,
  useIntegrationRequesters: m.useIntegrationRequesters,
  fetchAllRequesterEmails: m.fetchAllRequesterEmails,
}));
vi.mock('sonner', () => ({ toast: m.toast }));

import IntegrationDemandTab from './IntegrationDemandTab';

const appTheme = extendTheme({ ...getThemeConfig() });

const renderTab = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <IntegrationDemandTab />
    </CssVarsProvider>
  );

const demandRow = (over: Partial<IntegrationDemand> = {}): IntegrationDemand => ({
  integrationId: 'hubspot',
  name: 'HubSpot',
  stage: 'planned',
  total: 4,
  organizations: 2,
  firstRequestedAt: '2026-03-01T00:00:00.000Z',
  latestRequestedAt: '2026-03-04T00:00:00.000Z',
  ...over,
});

const requester = (over: Partial<IntegrationRequester> = {}): IntegrationRequester => ({
  userId: 'u1',
  name: 'Ada Admin',
  email: 'ada@example.com',
  organizationId: 'org1',
  organizationName: 'Example Org',
  requestedAt: '2026-03-02T00:00:00.000Z',
  ...over,
});

const demandState = (integrations: IntegrationDemand[], over: Record<string, unknown> = {}) => ({
  data: { integrations },
  error: null,
  isPending: false,
  ...over,
});

const requestersState = (rows: IntegrationRequester[], over: Record<string, unknown> = {}) => ({
  data: { pages: [{ data: rows, next_cursor: null }] },
  error: null,
  isPending: false,
  hasNextPage: false,
  isFetchingNextPage: false,
  fetchNextPage: vi.fn(),
  ...over,
});

const writeText = vi.fn();

const rateLimited = () =>
  new AxiosError('Too Many Requests', 'ERR_BAD_REQUEST', undefined, undefined, { status: 429 } as AxiosResponse);

/** A fetch the test settles by hand. */
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
};

describe('IntegrationDemandTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    writeText.mockResolvedValue(undefined);
    // fireEvent rather than userEvent throughout: userEvent installs its own clipboard stub.
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    m.useIntegrationDemand.mockReturnValue(
      demandState([
        demandRow(),
        demandRow({ integrationId: 'github', name: 'GitHub', stage: 'ga', total: 1, organizations: 1 }),
        demandRow({ integrationId: 'retired-connector', name: 'retired-connector', stage: null, total: 1 }),
      ])
    );
    m.useIntegrationRequesters.mockReturnValue(requestersState([]));
  });

  it('lists one row per integration in the order served, with its stage and totals', () => {
    renderTab();

    const rows = within(screen.getByTestId('admin-integration-demand-table')).getAllByRole('row').slice(1);
    expect(rows.map(row => row.getAttribute('data-testid'))).toEqual([
      'admin-integration-demand-row-hubspot',
      'admin-integration-demand-row-github',
      'admin-integration-demand-row-retired-connector',
    ]);
    const hubspot = screen.getByTestId('admin-integration-demand-row-hubspot');
    expect(hubspot).toHaveTextContent('HubSpot');
    expect(hubspot).toHaveTextContent('Roadmap');
    expect(within(hubspot).getAllByRole('cell')[2]).toHaveTextContent('4');
    expect(screen.getByTestId('admin-integration-demand-row-github')).toHaveTextContent('Live');
    expect(screen.getByTestId('admin-integration-demand-row-retired-connector')).toHaveTextContent('Not in catalog');
    // Nothing is fetched about requesters until a row is picked.
    expect(screen.queryByTestId('admin-integration-demand-requesters')).not.toBeInTheDocument();
    expect(m.useIntegrationRequesters).not.toHaveBeenCalled();
  });

  it("shows the selected integration's requesters with name, email, organization and date", () => {
    m.useIntegrationRequesters.mockReturnValue(
      requestersState([
        requester(),
        requester({ userId: 'u2', name: null, email: null, organizationId: 'gone', organizationName: null }),
        requester({
          userId: 'u3',
          name: 'Tia Third',
          email: 'tia@example.com',
          organizationId: null,
          organizationName: null,
        }),
      ])
    );
    renderTab();

    fireEvent.click(screen.getByTestId('admin-integration-demand-row-hubspot'));

    expect(m.useIntegrationRequesters).toHaveBeenCalledWith('hubspot');
    const panel = screen.getByTestId('admin-integration-demand-requesters');
    expect(panel).toHaveTextContent('Who requested HubSpot');
    const ada = screen.getByTestId('admin-integration-demand-requester-u1');
    expect(ada).toHaveTextContent('Ada Admin');
    expect(ada).toHaveTextContent('ada@example.com');
    expect(ada).toHaveTextContent('Example Org');
    expect(ada).toHaveTextContent(new Date('2026-03-02T00:00:00.000Z').toLocaleDateString());
    expect(screen.getByTestId('admin-integration-demand-requester-u2')).toHaveTextContent('Deleted account');
    expect(screen.getByTestId('admin-integration-demand-requester-u2')).toHaveTextContent('Deleted organization');
    expect(screen.getByTestId('admin-integration-demand-requester-u3')).not.toHaveTextContent('Deleted');
  });

  it('selects a row from the keyboard too', () => {
    renderTab();
    fireEvent.keyDown(screen.getByTestId('admin-integration-demand-row-github'), { key: 'Enter' });
    expect(m.useIntegrationRequesters).toHaveBeenCalledWith('github');
    expect(screen.getByTestId('admin-integration-demand-requesters')).toHaveTextContent('Who requested GitHub');
  });

  it('copies every requester email of the selected integration, not just the loaded page', async () => {
    m.fetchAllRequesterEmails.mockResolvedValue({ emails: ['ada@example.com', 'tia@example.com'], truncated: false });
    renderTab();
    fireEvent.click(screen.getByTestId('admin-integration-demand-row-hubspot'));

    fireEvent.click(screen.getByTestId('admin-integration-demand-copy-emails-btn'));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('ada@example.com, tia@example.com'));
    expect(m.fetchAllRequesterEmails).toHaveBeenCalledWith('hubspot');
    expect(m.toast.success).toHaveBeenCalledWith('Copied 2 emails');
  });

  it('says so instead of copying when no requester has an email, and reports a failed copy', async () => {
    m.fetchAllRequesterEmails.mockResolvedValueOnce({ emails: [], truncated: false });
    renderTab();
    fireEvent.click(screen.getByTestId('admin-integration-demand-row-hubspot'));

    fireEvent.click(screen.getByTestId('admin-integration-demand-copy-emails-btn'));
    await waitFor(() => expect(m.toast.info).toHaveBeenCalled());
    expect(writeText).not.toHaveBeenCalled();

    m.fetchAllRequesterEmails.mockRejectedValueOnce(new Error('network'));
    fireEvent.click(screen.getByTestId('admin-integration-demand-copy-emails-btn'));
    await waitFor(() => expect(m.toast.error).toHaveBeenCalled());
  });

  it('says the list is cut short when the page cap stopped the walk, and still copies what it has', async () => {
    m.fetchAllRequesterEmails.mockResolvedValue({ emails: ['ada@example.com'], truncated: true });
    renderTab();
    fireEvent.click(screen.getByTestId('admin-integration-demand-row-hubspot'));

    fireEvent.click(screen.getByTestId('admin-integration-demand-copy-emails-btn'));

    await waitFor(() => expect(m.toast.warning).toHaveBeenCalledTimes(1));
    expect(m.toast.warning.mock.calls[0][0]).toMatch(/longer than 5,000 requesters/);
    expect(writeText).toHaveBeenCalledWith('ada@example.com');
    expect(m.toast.success).not.toHaveBeenCalled();
  });

  it('tells an admin who hit the rate limit to wait, on a copy and on the list', async () => {
    m.fetchAllRequesterEmails.mockRejectedValueOnce(rateLimited());
    renderTab();
    fireEvent.click(screen.getByTestId('admin-integration-demand-row-hubspot'));

    fireEvent.click(screen.getByTestId('admin-integration-demand-copy-emails-btn'));
    await waitFor(() => expect(m.toast.error).toHaveBeenCalledWith('Too many requests, try again in a minute'));
    expect(writeText).not.toHaveBeenCalled();

    m.useIntegrationRequesters.mockReturnValue(requestersState([], { data: undefined, error: rateLimited() }));
    fireEvent.click(screen.getByTestId('admin-integration-demand-row-github'));
    expect(screen.getByTestId('admin-integration-demand-requesters-error')).toHaveTextContent(
      'Too many requests, try again in a minute'
    );
  });

  describe('where the browser has ClipboardItem (Safari needs the write to start inside the click)', () => {
    const write = vi.fn();

    beforeEach(() => {
      vi.stubGlobal(
        'ClipboardItem',
        class {
          constructor(public items: Record<string, Promise<Blob>>) {}
        }
      );
      Object.defineProperty(navigator, 'clipboard', { value: { writeText, write }, configurable: true });
      // Like a real browser: the write stays open until the blob promise settles.
      write.mockImplementation(async ([item]: Array<{ items: Record<string, Promise<Blob>> }>) => {
        await item.items['text/plain'];
      });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('starts the write synchronously in the click, with the emails still loading, and fills it when they land', async () => {
      const lookup = deferred<{ emails: string[]; truncated: boolean }>();
      m.fetchAllRequesterEmails.mockReturnValue(lookup.promise);
      renderTab();
      fireEvent.click(screen.getByTestId('admin-integration-demand-row-hubspot'));

      fireEvent.click(screen.getByTestId('admin-integration-demand-copy-emails-btn'));

      expect(write).toHaveBeenCalledTimes(1);
      expect(writeText).not.toHaveBeenCalled();
      expect(m.toast.success).not.toHaveBeenCalled();

      lookup.resolve({ emails: ['ada@example.com', 'tia@example.com'], truncated: false });
      await waitFor(() => expect(m.toast.success).toHaveBeenCalledWith('Copied 2 emails'));
      const [[items]] = write.mock.calls;
      const blob = await items[0].items['text/plain'];
      expect(blob.type).toBe('text/plain');
      expect(await blob.text()).toBe('ada@example.com, tia@example.com');
    });

    it('leaves the clipboard alone and reports the rate limit when the fetch is refused', async () => {
      m.fetchAllRequesterEmails.mockRejectedValue(rateLimited());
      renderTab();
      fireEvent.click(screen.getByTestId('admin-integration-demand-row-hubspot'));

      fireEvent.click(screen.getByTestId('admin-integration-demand-copy-emails-btn'));

      await waitFor(() => expect(m.toast.error).toHaveBeenCalledWith('Too many requests, try again in a minute'));
      expect(writeText).not.toHaveBeenCalled();
    });

    it('does not write an empty clipboard when nobody has an email', async () => {
      m.fetchAllRequesterEmails.mockResolvedValue({ emails: [], truncated: false });
      renderTab();
      fireEvent.click(screen.getByTestId('admin-integration-demand-row-hubspot'));

      fireEvent.click(screen.getByTestId('admin-integration-demand-copy-emails-btn'));

      await waitFor(() => expect(m.toast.info).toHaveBeenCalled());
      expect(m.toast.success).not.toHaveBeenCalled();
    });
  });

  it('offers the next page only while there is one', () => {
    const fetchNextPage = vi.fn();
    m.useIntegrationRequesters.mockReturnValue(requestersState([requester()], { hasNextPage: true, fetchNextPage }));
    renderTab();
    fireEvent.click(screen.getByTestId('admin-integration-demand-row-hubspot'));

    fireEvent.click(screen.getByTestId('admin-integration-demand-load-more-btn'));
    expect(fetchNextPage).toHaveBeenCalledTimes(1);

    m.useIntegrationRequesters.mockReturnValue(requestersState([requester()]));
    fireEvent.click(screen.getByTestId('admin-integration-demand-row-github'));
    expect(screen.queryByTestId('admin-integration-demand-load-more-btn')).not.toBeInTheDocument();
  });

  it('shows an empty state and an error state', () => {
    m.useIntegrationDemand.mockReturnValue(demandState([]));
    const { unmount } = renderTab();
    expect(screen.getByTestId('admin-integration-demand-empty')).toBeInTheDocument();
    unmount();

    m.useIntegrationDemand.mockReturnValue(demandState([], { data: undefined, error: new Error('403') }));
    renderTab();
    expect(screen.getByTestId('admin-integration-demand-error')).toBeInTheDocument();
  });
});
