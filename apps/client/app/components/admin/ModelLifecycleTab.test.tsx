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

import { ModelLifecycleTab } from './ModelLifecycleTab';

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
  staleReferences: [
    { surface: 'fallback-chain', key: 'gpt-live', referencedId: 'gpt-sunset', problem: 'deprecated' },
    { surface: 'fallback-default', key: 'default', referencedId: 'gpt-ghost', problem: 'unknown' },
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
  });

  it('renders the queue, the horizon and the stale references from one fetch', async () => {
    renderTab();

    const row = await screen.findByTestId('model-lifecycle-queue-row-gpt-sunset');
    expect(row).toHaveTextContent('anthropic-docs');
    expect(row).toHaveTextContent('gpt-live');

    // The catalog entry wins over the live one for a model in both lists.
    expect(screen.getByTestId('model-lifecycle-horizon-row-gpt-sunset')).toHaveTextContent('207d ago');
    expect(screen.getByTestId('model-lifecycle-horizon-row-gpt-soon')).toHaveTextContent('in 37d');
    expect(screen.getByTestId('model-lifecycle-stale-row-fallback-chain-gpt-sunset')).toHaveTextContent('deprecated');
    expect(screen.getByTestId('model-lifecycle-stale-row-fallback-default-gpt-ghost')).toHaveTextContent('unknown');
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

  it('dismiss posts immediately and refetches', async () => {
    renderTab();
    fireEvent.click(await screen.findByTestId('model-lifecycle-dismiss-gpt-sunset'));

    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    expect(mockPost.mock.calls[0][1]).toEqual({ modelId: 'gpt-sunset', action: 'dismiss' });
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));
  });

  it('surfaces the server validation message inside the open accept modal', async () => {
    mockPost.mockRejectedValue({
      message: 'Request failed with status code 400',
      response: { data: { message: 'replacedBy gpt-typo is unknown to the merged model list' } },
    });
    renderTab();
    fireEvent.click(await screen.findByTestId('model-lifecycle-accept-gpt-sunset'));
    fireEvent.change(screen.getByTestId('model-lifecycle-note-input'), { target: { value: 'operator pick' } });
    fireEvent.click(screen.getByTestId('model-lifecycle-accept-confirm-btn'));

    expect(await screen.findByTestId('model-lifecycle-accept-error')).toHaveTextContent('unknown to the merged model');
  });

  it('says so when nothing is awaiting a decision', async () => {
    mockGet.mockResolvedValue({ data: { ...STATUS, queue: [] } });
    renderTab();
    expect(await screen.findByTestId('model-lifecycle-queue-empty')).toBeInTheDocument();
  });
});
