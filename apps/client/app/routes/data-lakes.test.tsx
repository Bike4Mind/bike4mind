import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useSearch: () => ({}),
}));

// The shared manage-knowledge gate reads the admin settings cache and the user store.
const isAdminFeatureEnabled = vi.fn(() => true);
vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isAdminFeatureEnabled, isFeatureEnabled: vi.fn(), isLoading: false }),
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector?: (s: { isAdmin: boolean }) => unknown) =>
    selector ? selector({ isAdmin: false }) : { isAdmin: false },
}));

// Stub the heavy explorer: this test asserts only which handlers the route hands down,
// and how they behave when invoked.
vi.mock('@client/app/components/datalake/DataLakeExplorer', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test stub
  default: ({ onManage, onDiscover }: any) => (
    <div
      data-testid="explorer"
      data-can-manage={String(typeof onManage === 'function')}
      data-can-discover={String(typeof onDiscover === 'function')}
    >
      <button data-testid="discover" onClick={onDiscover} />
    </div>
  ),
}));

import DataLakesHome from './data-lakes';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';

describe('DataLakesHome - the manage-knowledge gate on the standalone surface (#841)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isAdminFeatureEnabled.mockReturnValue(true);
    useDataLakeWizardStore.setState({ isManagerOpen: false, managerTab: 'mine' });
  });

  it('offers manage and discover when EnableDataLakes is on, to a non-admin (their OWN lakes)', () => {
    render(<DataLakesHome />);

    const explorer = screen.getByTestId('explorer');
    expect(explorer).toHaveAttribute('data-can-manage', 'true');
    expect(explorer).toHaveAttribute('data-can-discover', 'true');
  });

  it('deep-links discover to the public catalog tab', () => {
    render(<DataLakesHome />);

    fireEvent.click(screen.getByTestId('discover'));

    expect(useDataLakeWizardStore.getState().isManagerOpen).toBe(true);
    expect(useDataLakeWizardStore.getState().managerTab).toBe('discover');
  });

  it('withholds BOTH actions when EnableDataLakes is off, since each opens the same dead-end panel', () => {
    isAdminFeatureEnabled.mockReturnValue(false);

    render(<DataLakesHome />);

    // Discover shares Manage's gate: it deep-links the same manager modal, whose panel
    // renders nothing without the flag, so ungated it opened an empty full-screen modal.
    const explorer = screen.getByTestId('explorer');
    expect(explorer).toHaveAttribute('data-can-manage', 'false');
    expect(explorer).toHaveAttribute('data-can-discover', 'false');
  });
});
