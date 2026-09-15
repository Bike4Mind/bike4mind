import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import RestrictedPage from './RestrictedPage';

const mockNavigate = vi.fn();
const mockHistoryPush = vi.fn();
const mockHistoryReplace = vi.fn();
const mockUseUser = vi.fn();
const mockRouterState = {
  location: { pathname: '/admin', searchStr: '', hash: '', search: {} as Record<string, unknown> },
};

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
  useRouter: () => ({
    state: mockRouterState,
    history: { push: mockHistoryPush, replace: mockHistoryReplace },
  }),
}));

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => mockUseUser(),
}));

vi.mock('@client/app/utils/user', () => ({
  userIsDeveloper: () => false,
}));

const mockUseEntitlements = vi.fn();
vi.mock('@client/app/hooks/data/entitlements', () => ({
  useEntitlements: (options: { enabled?: boolean }) => mockUseEntitlements(options),
}));

/** Query-state shorthands for the entitlement gate tests. */
const entitlementsQuery = {
  success: (entitlements: string[]) => ({ data: entitlements, isSuccess: true, isError: false }),
  pending: () => ({ data: undefined, isSuccess: false, isError: false }),
  error: () => ({ data: undefined, isSuccess: false, isError: true }),
};

describe('RestrictedPage — auth redirect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseEntitlements.mockReturnValue(entitlementsQuery.pending());
    mockRouterState.location = { pathname: '/admin', searchStr: '', hash: '', search: {} };
  });

  it('redirects unauthenticated users to /login with redirectTo set to the current path', () => {
    mockUseUser.mockReturnValue({ currentUser: null });
    mockRouterState.location = { pathname: '/admin', searchStr: '', hash: '', search: {} };

    render(
      <RestrictedPage>
        <div>secret</div>
      </RestrictedPage>
    );

    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/login',
      search: { redirectTo: '/admin' },
    });
  });

  it('preserves the query string in redirectTo', () => {
    mockUseUser.mockReturnValue({ currentUser: null });
    mockRouterState.location = {
      pathname: '/quests',
      searchStr: '?filter=open',
      hash: '',
      search: { filter: 'open' },
    };

    render(
      <RestrictedPage>
        <div>secret</div>
      </RestrictedPage>
    );

    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/login',
      search: { redirectTo: '/quests?filter=open' },
    });
  });

  it('does not set redirectTo when the user lands on /', () => {
    mockUseUser.mockReturnValue({ currentUser: null });
    mockRouterState.location = { pathname: '/', searchStr: '', hash: '', search: {} };

    render(
      <RestrictedPage>
        <div>secret</div>
      </RestrictedPage>
    );

    expect(mockNavigate).toHaveBeenCalledWith({ to: '/login', search: undefined });
  });

  it('post-login: replaces history with the redirectTo target (preserves query, no back-button trap)', () => {
    mockUseUser.mockReturnValue({ currentUser: { id: 'u1', isAdmin: true } });
    mockRouterState.location = {
      pathname: '/login',
      searchStr: '?redirectTo=%2Fquests%3Ffilter%3Dopen',
      hash: '',
      search: { redirectTo: '/quests?filter=open' },
    };

    render(
      <RestrictedPage>
        <div>login</div>
      </RestrictedPage>
    );

    expect(mockHistoryReplace).toHaveBeenCalledWith('/quests?filter=open');
    expect(mockHistoryPush).not.toHaveBeenCalled();
  });

  it('post-login: falls back to /new when redirectTo is unsafe', () => {
    mockUseUser.mockReturnValue({ currentUser: { id: 'u1', isAdmin: true } });
    mockRouterState.location = {
      pathname: '/login',
      searchStr: '?redirectTo=%2F%2Fevil.com',
      hash: '',
      search: { redirectTo: '//evil.com' },
    };

    render(
      <RestrictedPage>
        <div>login</div>
      </RestrictedPage>
    );

    expect(mockHistoryReplace).toHaveBeenCalledWith('/new');
    expect(mockHistoryPush).not.toHaveBeenCalled();
  });

  it('preserves the hash fragment in redirectTo', () => {
    mockUseUser.mockReturnValue({ currentUser: null });
    mockRouterState.location = {
      pathname: '/quests',
      searchStr: '',
      hash: 'section-2',
      search: {},
    };

    render(
      <RestrictedPage>
        <div>secret</div>
      </RestrictedPage>
    );

    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/login',
      search: { redirectTo: '/quests#section-2' },
    });
  });
});

describe('RestrictedPage — requireEntitlement gate', () => {
  const learner = { id: 'u1', isAdmin: false, tags: [] as string[] };

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseUser.mockReturnValue({ currentUser: learner });
    mockRouterState.location = { pathname: '/someproduct', searchStr: '', hash: '', search: {} };
  });

  it('renders children when the server-resolved entitlements include the key', () => {
    mockUseEntitlements.mockReturnValue(entitlementsQuery.success(['someproduct:pro']));

    const { queryByText } = render(
      <RestrictedPage requireEntitlement="someproduct:pro">
        <div>pro content</div>
      </RestrictedPage>
    );

    expect(queryByText('pro content')).not.toBeNull();
    expect(mockHistoryPush).not.toHaveBeenCalled();
  });

  it('normalizes the required key before comparing', () => {
    mockUseEntitlements.mockReturnValue(entitlementsQuery.success(['someproduct:pro']));

    const { queryByText } = render(
      <RestrictedPage requireEntitlement="  SomeProduct:PRO ">
        <div>pro content</div>
      </RestrictedPage>
    );

    expect(queryByText('pro content')).not.toBeNull();
  });

  it('redirects a definitive denial to fallbackPath and renders nothing', () => {
    mockUseEntitlements.mockReturnValue(entitlementsQuery.success(['other:pro']));

    const { queryByText } = render(
      <RestrictedPage requireEntitlement="someproduct:pro" fallbackPath="/someproduct/upgrade">
        <div>pro content</div>
      </RestrictedPage>
    );

    expect(queryByText('pro content')).toBeNull();
    expect(mockHistoryPush).toHaveBeenCalledWith('/someproduct/upgrade');
  });

  it('denial defaults to /new when no fallbackPath is given', () => {
    mockUseEntitlements.mockReturnValue(entitlementsQuery.success([]));

    render(
      <RestrictedPage requireEntitlement="someproduct:pro">
        <div>pro content</div>
      </RestrictedPage>
    );

    expect(mockHistoryPush).toHaveBeenCalledWith('/new');
  });

  it('an unsafe fallbackPath falls back to /new (open-redirect guard)', () => {
    mockUseEntitlements.mockReturnValue(entitlementsQuery.success([]));

    render(
      <RestrictedPage requireEntitlement="someproduct:pro" fallbackPath="//evil.com">
        <div>pro content</div>
      </RestrictedPage>
    );

    expect(mockHistoryPush).toHaveBeenCalledWith('/new');
  });

  it('renders null while the entitlement query is pending — no redirect', () => {
    mockUseEntitlements.mockReturnValue(entitlementsQuery.pending());

    const { queryByText } = render(
      <RestrictedPage requireEntitlement="someproduct:pro">
        <div>pro content</div>
      </RestrictedPage>
    );

    expect(queryByText('pro content')).toBeNull();
    expect(mockHistoryPush).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('fails open on a query error — renders children, never ejects (UX gate, not a security control)', () => {
    mockUseEntitlements.mockReturnValue(entitlementsQuery.error());

    const { queryByText } = render(
      <RestrictedPage requireEntitlement="someproduct:pro">
        <div>pro content</div>
      </RestrictedPage>
    );

    expect(queryByText('pro content')).not.toBeNull();
    expect(mockHistoryPush).not.toHaveBeenCalled();
  });

  it('admins bypass without fetching entitlements', () => {
    mockUseUser.mockReturnValue({ currentUser: { id: 'a1', isAdmin: true, tags: [] } });
    mockUseEntitlements.mockReturnValue(entitlementsQuery.pending());

    const { queryByText } = render(
      <RestrictedPage requireEntitlement="someproduct:pro">
        <div>pro content</div>
      </RestrictedPage>
    );

    expect(queryByText('pro content')).not.toBeNull();
    expect(mockUseEntitlements).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });

  it('with both requireFeatureTag and requireEntitlement set, satisfying the tag grants (OR)', () => {
    mockUseUser.mockReturnValue({ currentUser: { ...learner, tags: ['SomeProduct'] } });
    mockUseEntitlements.mockReturnValue(entitlementsQuery.success([]));

    const { queryByText } = render(
      <RestrictedPage requireFeatureTag="someproduct" requireEntitlement="someproduct:pro">
        <div>pro content</div>
      </RestrictedPage>
    );

    expect(queryByText('pro content')).not.toBeNull();
    expect(mockHistoryPush).not.toHaveBeenCalled();
  });

  it('with both set and neither satisfied, denies once the query resolves', () => {
    mockUseEntitlements.mockReturnValue(entitlementsQuery.success([]));

    const { queryByText } = render(
      <RestrictedPage requireFeatureTag="someproduct" requireEntitlement="someproduct:pro">
        <div>pro content</div>
      </RestrictedPage>
    );

    expect(queryByText('pro content')).toBeNull();
    expect(mockHistoryPush).toHaveBeenCalledWith('/new');
  });

  it('requireFeatureTag alone keeps its existing denial behavior (untagged → /new)', () => {
    const { queryByText } = render(
      <RestrictedPage requireFeatureTag="someproduct">
        <div>tagged content</div>
      </RestrictedPage>
    );

    expect(queryByText('tagged content')).toBeNull();
    expect(mockHistoryPush).toHaveBeenCalledWith('/new');
  });

  it('requireFeatureTag alone never fetches entitlements', () => {
    mockUseUser.mockReturnValue({ currentUser: { ...learner, tags: ['someproduct'] } });

    render(
      <RestrictedPage requireFeatureTag="someproduct">
        <div>tagged content</div>
      </RestrictedPage>
    );

    expect(mockUseEntitlements).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });
});

describe('RestrictedPage — requireAdmin denial honors fallbackPath', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseEntitlements.mockReturnValue(entitlementsQuery.pending());
    mockUseUser.mockReturnValue({ currentUser: { id: 'u1', isAdmin: false, tags: [] } });
    mockRouterState.location = { pathname: '/admin', searchStr: '', hash: '', search: {} };
  });

  it('redirects a non-admin to the custom fallbackPath and renders nothing', () => {
    const { queryByText } = render(
      <RestrictedPage requireAdmin fallbackPath="/somewhere/public">
        <div>admin content</div>
      </RestrictedPage>
    );

    expect(queryByText('admin content')).toBeNull();
    expect(mockHistoryPush).toHaveBeenCalledWith('/somewhere/public');
  });

  it('an unsafe fallbackPath falls back to /new (matches the pre-fallbackPath behavior)', () => {
    render(
      <RestrictedPage requireAdmin fallbackPath="//evil.com">
        <div>admin content</div>
      </RestrictedPage>
    );

    expect(mockHistoryPush).toHaveBeenCalledWith('/new');
  });
});
