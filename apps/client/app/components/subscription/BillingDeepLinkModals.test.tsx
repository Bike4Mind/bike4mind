import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, renderHook } from '@testing-library/react';
import BillingDeepLinkModals, { useBillingView } from './BillingDeepLinkModals';

const mocks = vi.hoisted(() => ({
  location: { pathname: '/notebooks/n1', searchStr: '', search: {} as Record<string, unknown>, hash: '' },
  push: vi.fn(),
  replace: vi.fn(),
  creditsEnabled: true,
}));

function setLocation(searchStr: string, hash = '') {
  mocks.location.searchStr = searchStr;
  mocks.location.search = Object.fromEntries(new URLSearchParams(searchStr));
  mocks.location.hash = hash;
}

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({
    state: { location: mocks.location },
    history: { push: mocks.push, replace: mocks.replace },
  }),
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) => select({ location: mocks.location }),
}));
vi.mock('@client/app/hooks/data/settings', () => ({ useGetSettingsValue: () => mocks.creditsEnabled }));

vi.mock('@client/app/components/subscription/BillingModal', () => ({
  default: ({ open, focus, onClose }: { open: boolean; focus: string; onClose: () => void }) =>
    open ? (
      <div data-testid="billing-modal" data-focus={focus}>
        <button data-testid="billing-modal-close" onClick={onClose} />
      </div>
    ) : null,
}));

describe('BillingDeepLinkModals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.creditsEnabled = true;
    setLocation('');
  });

  it('opens nothing without the billing param', () => {
    render(<BillingDeepLinkModals />);
    expect(screen.queryByTestId('billing-modal')).not.toBeInTheDocument();
  });

  it.each(['credits', 'plans'])('opens the one Billing view focused on %s for ?billing=%s', view => {
    setLocation(`?billing=${view}`);
    render(<BillingDeepLinkModals />);
    expect(screen.getByTestId('billing-modal')).toHaveAttribute('data-focus', view);
  });

  it('ignores an unknown view', () => {
    setLocation('?billing=bogus');
    render(<BillingDeepLinkModals />);
    expect(screen.queryByTestId('billing-modal')).not.toBeInTheDocument();
  });

  it('stays closed when credits are not enforced', () => {
    mocks.creditsEnabled = false;
    setLocation('?billing=plans');
    render(<BillingDeepLinkModals />);
    expect(screen.queryByTestId('billing-modal')).not.toBeInTheDocument();
  });

  it('closing strips only the billing param, keeping the rest of the URL', () => {
    setLocation('?projectId=p1&billing=credits', 'top');
    render(<BillingDeepLinkModals />);
    fireEvent.click(screen.getByTestId('billing-modal-close'));
    expect(mocks.replace).toHaveBeenCalledWith('/notebooks/n1?projectId=p1#top');
    expect(mocks.push).not.toHaveBeenCalled();
  });
});

describe('useBillingView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setLocation('?projectId=p1');
  });

  it('opens a view by pushing a URL that carries it', () => {
    const { result } = renderHook(() => useBillingView());
    result.current.openView('plans');
    expect(mocks.push).toHaveBeenCalledWith('/notebooks/n1?projectId=p1&billing=plans');
  });
});
