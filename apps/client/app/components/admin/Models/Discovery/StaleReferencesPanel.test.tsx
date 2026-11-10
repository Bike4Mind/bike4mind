import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  DELEGATE,
  FULL_ADMIN,
  LIFECYCLE,
  adminRow,
  makeWrapper,
  modelList,
  newQueryClient,
} from './__tests__/discoveryTestKit';
import type { LifecycleStatus } from './discoveryApi';

const m = vi.hoisted(() => ({
  get: vi.fn(),
  currentUser: { id: 'admin-1', isAdmin: true } as Record<string, unknown>,
}));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: (...a: unknown[]) => m.get(...a) } }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: m.currentUser }) }));

import { StaleReferencesPanel } from './StaleReferencesPanel';

const LIFECYCLE_PATH = '/api/admin/model-deprecation-status';
let queryClient = newQueryClient();
let lifecycle: LifecycleStatus = LIFECYCLE;

const renderPanel = () => render(<StaleReferencesPanel />, { wrapper: makeWrapper(queryClient) });

beforeEach(() => {
  vi.clearAllMocks();
  queryClient = newQueryClient();
  m.currentUser = FULL_ADMIN;
  lifecycle = LIFECYCLE;
  m.get.mockImplementation(async (url: string) => {
    if (url === LIFECYCLE_PATH) return { data: lifecycle };
    if (url === '/api/admin/models') {
      return { data: modelList([adminRow('gpt-sunset', { name: 'GPT Sunset' }), adminRow('gpt-live')]) };
    }
    throw new Error(`unexpected GET ${url}`);
  });
});

describe('StaleReferencesPanel', () => {
  it('shows no report until Check references is clicked', async () => {
    renderPanel();

    expect(await screen.findByTestId('discovery-references-idle')).toBeInTheDocument();
    expect(screen.queryByTestId('discovery-references-table')).not.toBeInTheDocument();
  });

  it('lists each reference by name with a readable problem, including not callable', async () => {
    renderPanel();
    fireEvent.click(screen.getByTestId('discovery-check-references-btn'));

    const deprecated = await screen.findByTestId('discovery-reference-row-fallback-chain-gpt-sunset');
    await waitFor(() => expect(deprecated).toHaveTextContent('GPT Sunset'));
    expect(deprecated).toHaveTextContent('Deprecated');
    expect(screen.getByTestId('discovery-reference-row-fallback-default-gpt-ghost')).toHaveTextContent('Unknown model');
    expect(screen.getByTestId('discovery-reference-row-fallback-chain-gpt-metadata-only')).toHaveTextContent(
      'Not callable'
    );
  });

  it('asks the server again on every check', async () => {
    renderPanel();
    await waitFor(() => expect(m.get).toHaveBeenCalledWith(LIFECYCLE_PATH));
    const before = m.get.mock.calls.filter(([url]) => url === LIFECYCLE_PATH).length;

    fireEvent.click(screen.getByTestId('discovery-check-references-btn'));
    await screen.findByTestId('discovery-references-table');

    expect(m.get.mock.calls.filter(([url]) => url === LIFECYCLE_PATH).length).toBe(before + 1);
  });

  it('shows the server error text when the reference report failed', async () => {
    lifecycle = { ...LIFECYCLE, staleReferences: null, staleReferencesError: 'models.dev timed out' };
    renderPanel();
    fireEvent.click(screen.getByTestId('discovery-check-references-btn'));

    expect(await screen.findByTestId('discovery-references-error')).toHaveTextContent('models.dev timed out');
  });

  it('says every reference is fine when none is stale', async () => {
    lifecycle = { ...LIFECYCLE, staleReferences: [] };
    renderPanel();
    fireEvent.click(screen.getByTestId('discovery-check-references-btn'));

    expect(await screen.findByTestId('discovery-references-none')).toHaveTextContent(
      'Every reference points at an available model.'
    );
  });

  it('blocks the check for a delegate who cannot make model writes', async () => {
    m.currentUser = DELEGATE;
    renderPanel();

    expect(screen.getByTestId('discovery-check-references-btn')).toBeDisabled();
  });
});
