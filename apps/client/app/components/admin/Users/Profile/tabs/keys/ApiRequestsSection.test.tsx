import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProfileTestWrapper } from '../../profileTestUtils';
import type { IUserApiKeyDocument } from '@bike4mind/common';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: mocks.get } }));
import { ApiRequestsSection } from './ApiRequestsSection';

const userId = 'a'.repeat(24);
const keyId = 'b'.repeat(24);
const keys = [{ id: keyId, name: 'Example key', keyPrefix: 'example-prefix' }] as IUserApiKeyDocument[];
const entry = {
  type: 'api_request',
  id: 'r1',
  at: '2026-11-01T12:00:00Z',
  summary: 'GET /api/v1/me - 200',
  request: { keyId, method: 'GET', endpoint: '/api/v1/me', statusCode: 200, responseTimeMs: 45, ip: '203.0.113.1' },
};
const show = () => render(<ApiRequestsSection userId={userId} apiKeys={keys} />, { wrapper: ProfileTestWrapper });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ApiRequestsSection', () => {
  it('shows every loaded request without a second client-side pager', async () => {
    mocks.get.mockResolvedValue({
      data: {
        entries: Array.from({ length: 30 }, (_, index) => ({
          ...entry,
          id: `r${index}`,
          request: { ...entry.request, endpoint: `/api/example/${index}` },
        })),
        nextCursor: 'next',
      },
    });
    show();
    expect(await screen.findByText('/api/example/29')).toBeInTheDocument();
    expect(screen.queryByText('Rows per page')).not.toBeInTheDocument();
  });
  it('renders real request details, refreshes, and loads the next server page', async () => {
    mocks.get.mockImplementation(async (_url: string, options: { params: { cursor?: string } }) => ({
      data: {
        entries: options.params.cursor
          ? [{ ...entry, id: 'r2', request: { ...entry.request, endpoint: '/api/files', statusCode: 403 } }]
          : [entry],
        nextCursor: options.params.cursor ? null : 'next',
      },
    }));
    show();
    expect(await screen.findByText('/api/v1/me')).toBeInTheDocument();
    expect(screen.getByText('45 ms')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('user-api-requests-more-btn'));
    expect(await screen.findByText('/api/files')).toBeInTheDocument();
    expect(mocks.get).toHaveBeenLastCalledWith(`/api/admin/users/${userId}/timeline`, {
      params: { types: 'api_request', limit: '30', cursor: 'next' },
    });
    fireEvent.click(screen.getByTestId('user-api-requests-refresh-btn'));
    await waitFor(() => expect(mocks.get.mock.calls.length).toBeGreaterThan(2));
  });

  it('filters by key on the server rather than filtering a returned page', async () => {
    mocks.get.mockResolvedValue({ data: { entries: [], nextCursor: null } });
    show();
    await screen.findByText('No retained requests match this key filter.');
    fireEvent.click(screen.getByTestId('user-api-requests-key-filter').querySelector('button')!);
    fireEvent.click(await screen.findByRole('option', { name: 'Example key (example-prefix)' }));
    await waitFor(() =>
      expect(mocks.get).toHaveBeenLastCalledWith(`/api/admin/users/${userId}/timeline`, {
        params: { types: 'api_request', limit: '30', apiKeyId: keyId },
      })
    );
    fireEvent.change(screen.getByTestId('user-api-requests-from').querySelector('input')!, {
      target: { value: '2026-11-01' },
    });
    await waitFor(() =>
      expect(mocks.get).toHaveBeenLastCalledWith(`/api/admin/users/${userId}/timeline`, {
        params: { types: 'api_request', limit: '30', apiKeyId: keyId, from: '2026-11-01T00:00:00.000Z' },
      })
    );
  });

  it('shows a failed read as an error with retry, not as no activity', async () => {
    mocks.get.mockRejectedValue(new Error('read failed'));
    show();
    expect(await screen.findByText('API requests could not be loaded.')).toBeInTheDocument();
    expect(screen.queryByText('No retained requests match this key filter.')).not.toBeInTheDocument();
  });
});
