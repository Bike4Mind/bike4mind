import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { buildProfile, ProfileTestWrapper } from '../profileTestUtils';
import type { AdminUserProfile } from '../userProfileModel';

const mocks = vi.hoisted(() => ({ get: vi.fn(), navigate: vi.fn() }));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: mocks.get } }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('./ActiveSessions', () => ({ ActiveSessions: () => <div data-testid="stub-active-sessions" /> }));

import { SignInsTab, signInDevice, signInResultLabel } from './SignInsTab';

const signIn = (overrides: Record<string, unknown>) => ({
  id: 'si-1',
  at: '2026-10-20T09:00:00.000Z',
  result: 'success',
  event: 'login_success',
  ...overrides,
});

const SIGN_INS = [
  signIn({
    id: 'ok',
    method: 'google',
    ip: '198.51.100.4',
    location: 'Lisbon, PT',
    browser: 'Chrome',
    operatingSystem: 'macOS',
    deviceType: 'Desktop',
  }),
  signIn({ id: 'failed', result: 'failed', event: 'step_up_failed', method: 'otc' }),
  signIn({ id: 'blocked', result: 'blocked', event: 'session_reuse_revoked' }),
];

type ClusterResponse = { fingerprintAvailable: boolean; windowDays: number; matches: unknown[]; truncated: boolean };

const respond = (signIns: unknown[], cluster: ClusterResponse, nextCursor: string | null = null) =>
  mocks.get.mockImplementation((url: string) =>
    Promise.resolve({ data: url.endsWith('/signup-cluster') ? cluster : { entries: signIns, nextCursor } })
  );

const NO_CLUSTER: ClusterResponse = { fingerprintAvailable: true, windowDays: 7, matches: [], truncated: false };

const renderTab = (user: AdminUserProfile = buildProfile()) =>
  render(<SignInsTab user={user} />, { wrapper: ProfileTestWrapper });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sign-in labels', () => {
  it('names each result in words, with the reason for a refusal', () => {
    expect(signInResultLabel({ result: 'success', event: 'login_success' })).toBe('Success');
    expect(signInResultLabel({ result: 'failed', event: 'step_up_failed' })).toBe('Failed: 2FA failed');
    expect(signInResultLabel({ result: 'blocked', event: 'refresh_replay_capped' })).toBe('Blocked: token replay');
  });

  it('joins what is known about the device', () => {
    expect(signInDevice({ browser: 'Chrome', operatingSystem: 'macOS', deviceType: 'Desktop' })).toBe(
      'Chrome on macOS \u00b7 Desktop'
    );
    expect(signInDevice({})).toBe('-');
  });
});

describe('SignInsTab', () => {
  it('lists each result type with a labelled chip and placeholders for unknown fields', async () => {
    respond(SIGN_INS, NO_CLUSTER);
    renderTab();

    const rows = await screen.findAllByTestId('user-signins-row');
    expect(rows).toHaveLength(3);
    const chips = rows.map(row => within(row).getByTestId('user-signin-result'));
    expect(chips.map(chip => [chip.textContent, chip.getAttribute('data-tone')])).toEqual([
      ['Success', 'good'],
      ['Failed: 2FA failed', 'bad'],
      ['Blocked: session reuse', 'bad'],
    ]);
    expect(rows[0]).toHaveTextContent('Google');
    expect(rows[0]).toHaveTextContent('198.51.100.4');
    expect(rows[0]).toHaveTextContent('Lisbon, PT');
    expect(rows[1]).toHaveTextContent('One-time code');
    expect(rows[2]).toHaveTextContent('-');
  });

  it('loads older sign-ins from the cursor', async () => {
    respond(SIGN_INS.slice(0, 1), NO_CLUSTER, 'NEXT');
    renderTab();

    fireEvent.click(await screen.findByTestId('user-signins-load-more-btn'));

    expect(mocks.get).toHaveBeenLastCalledWith('/api/admin/users/test-user-1/sign-ins', {
      params: { limit: '50', cursor: 'NEXT' },
    });
  });

  it('shows the signup record with method, network and verification', async () => {
    respond([], NO_CLUSTER);
    renderTab(
      buildProfile({
        email: 'ada@Example.com',
        emailVerified: false,
        acquisition: { signupMethod: 'github', capturedAt: new Date('2026-01-01T00:00:00Z') },
        signupMeta: {
          ip: '203.0.113.7',
          userAgent: 'Mozilla/5.0 test',
          asn: 64500,
          asnOrg: 'Example Hosting',
          country: 'PT',
          isDatacenter: true,
          capturedAt: new Date('2026-01-01T00:00:00Z'),
        },
      })
    );

    const record = screen.getByTestId('user-profile-signup');
    expect(within(record).getByTestId('user-signup-method-badge')).toHaveTextContent('GitHub');
    expect(within(record).getByTestId('user-signup-verification')).toHaveTextContent('Not verified');
    expect(record).toHaveTextContent('203.0.113.7');
    expect(record).toHaveTextContent('AS64500 Example Hosting (hosting network)');
    expect(record).toHaveTextContent('Mozilla/5.0 test');
    expect(await within(record).findByText('No other account from this client within 7 days')).toBeInTheDocument();

    fireEvent.click(within(record).getByTestId('user-signup-domain-link'));
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/admin', search: { tab: 'users', groupBy: 'emailDomain' } });
  });

  it('labels a legacy signup method as stored and shows dashes for a missing record', async () => {
    respond([], { ...NO_CLUSTER, fingerprintAvailable: false });
    renderTab(buildProfile({ acquisition: { signupMethod: 'magic-link', capturedAt: new Date() } }));

    expect(screen.getByTestId('user-signup-method-badge')).toHaveTextContent('Other (magic-link)');
    expect(await screen.findByText('No signup fingerprint recorded')).toBeInTheDocument();
  });

  it('links each account in the signup cluster to its profile', async () => {
    respond([], {
      fingerprintAvailable: true,
      windowDays: 7,
      truncated: false,
      matches: [{ id: 'other-1', name: 'Grace Hopper', createdAt: '2026-01-02T00:00:00.000Z' }],
    });
    renderTab();

    const cluster = await screen.findByTestId('user-signup-cluster');
    expect(cluster).toHaveTextContent('1 other account from this client within 7 days');
    fireEvent.click(within(cluster).getByTestId('user-signup-cluster-link'));
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/admin/users/$userId', params: { userId: 'other-1' } });
  });

  it('says so when the sign-ins cannot be loaded', async () => {
    mocks.get.mockImplementation((url: string) =>
      url.endsWith('/signup-cluster') ? Promise.resolve({ data: NO_CLUSTER }) : Promise.reject(new Error('boom'))
    );
    renderTab();
    expect(await screen.findByText('Sign-ins could not be loaded.')).toBeInTheDocument();
  });

  it('says the signup cluster could not be checked when its request fails', async () => {
    mocks.get.mockImplementation((url: string) =>
      url.endsWith('/signup-cluster')
        ? Promise.reject(new Error('boom'))
        : Promise.resolve({ data: { entries: [], nextCursor: null } })
    );
    renderTab();
    expect(await screen.findByText('Could not be checked')).toBeInTheDocument();
  });
});
