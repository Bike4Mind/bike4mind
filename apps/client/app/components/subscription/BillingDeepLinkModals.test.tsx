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

type ModalProps = { open: boolean; onClose: () => void };
vi.mock('@client/app/components/subscription/CreditsModal', () => ({
  default: ({ open, onClose }: ModalProps) =>
    open ? <button data-testid="credits-modal-close-btn" onClick={onClose} /> : null,
}));
vi.mock('@client/app/components/subscription/SubscriptionModal', () => ({
  default: ({ open, onClose }: ModalProps) =>
    open ? <button data-testid="plans-modal-close-btn" onClick={onClose} /> : null,
}));

describe('BillingDeepLinkModals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.creditsEnabled = true;
    setLocation('');
  });

  it('opens nothing without the billing param', () => {
    render(<BillingDeepLinkModals />);
    expect(screen.queryByTestId('credits-modal-close-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('plans-modal-close-btn')).not.toBeInTheDocument();
  });

  it('opens the credits modal for ?billing=credits', () => {
    setLocation('?billing=credits');
    render(<BillingDeepLinkModals />);
    expect(screen.getByTestId('credits-modal-close-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('plans-modal-close-btn')).not.toBeInTheDocument();
  });

  it('opens the plans modal for ?billing=plans', () => {
    setLocation('?billing=plans');
    render(<BillingDeepLinkModals />);
    expect(screen.getByTestId('plans-modal-close-btn')).toBeInTheDocument();
  });

  it('ignores an unknown view', () => {
    setLocation('?billing=bogus');
    render(<BillingDeepLinkModals />);
    expect(screen.queryByTestId('credits-modal-close-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('plans-modal-close-btn')).not.toBeInTheDocument();
  });

  it('stays closed when credits are not enforced', () => {
    mocks.creditsEnabled = false;
    setLocation('?billing=plans');
    render(<BillingDeepLinkModals />);
    expect(screen.queryByTestId('plans-modal-close-btn')).not.toBeInTheDocument();
  });

  it('closing strips only the billing param, keeping the rest of the URL', () => {
    setLocation('?projectId=p1&billing=credits', 'top');
    render(<BillingDeepLinkModals />);
    fireEvent.click(screen.getByTestId('credits-modal-close-btn'));
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
