import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

// The gate reads the admin settings cache; the tests drive the flag per case.
const isAdminFeatureEnabled = vi.fn();
vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isAdminFeatureEnabled, isFeatureEnabled: vi.fn(), isLoading: false }),
}));

// `useManageKnowledge` reads `isAdmin` through a selector, so the mock applies the
// selector to a mutable state object the tests reassign (same shape as meetings.test.ts).
const { userState } = vi.hoisted(() => ({ userState: { isAdmin: false } }));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector?: (s: typeof userState) => unknown) => (selector ? selector(userState) : userState),
}));

const openManager = vi.fn();
vi.mock('@client/app/stores/useDataLakeWizardStore', () => ({
  useDataLakeWizardStore: (selector: (s: { openManager: typeof openManager }) => unknown) => selector({ openManager }),
}));

import { ManageKnowledgeButton, useManageKnowledge } from './manageKnowledge';

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

beforeEach(() => {
  vi.clearAllMocks();
  isAdminFeatureEnabled.mockReturnValue(true);
  userState.isAdmin = false;
});

describe('useManageKnowledge - the one core gate (#841)', () => {
  it('grants a non-admin when EnableDataLakes is on (their OWN lakes)', () => {
    const { result } = renderHook(() => useManageKnowledge());

    expect(result.current.canManage).toBe(true);
    result.current.onManage?.();
    // Called bare: `openManager` takes an optional tab, and a click event must never
    // arrive as that argument.
    expect(openManager).toHaveBeenCalledWith();
  });

  it('denies everyone when EnableDataLakes is off, since every manage request 403s', () => {
    isAdminFeatureEnabled.mockImplementation((key: string) => key !== 'EnableDataLakes');
    userState.isAdmin = true;

    const { result } = renderHook(() => useManageKnowledge());

    expect(result.current.canManage).toBe(false);
    // Undefined rather than a no-op, so a consuming `onManage` prop hides its affordance.
    expect(result.current.onManage).toBeUndefined();
  });

  it('denies a non-admin on a curated surface (requireAdmin), the predicate overlays hand-rolled', () => {
    const { result } = renderHook(() => useManageKnowledge({ requireAdmin: true }));

    expect(result.current.canManage).toBe(false);
    expect(result.current.onManage).toBeUndefined();
  });

  it('grants an admin on a curated surface', () => {
    userState.isAdmin = true;

    const { result } = renderHook(() => useManageKnowledge({ requireAdmin: true }));

    expect(result.current.canManage).toBe(true);
  });
});

describe('ManageKnowledgeButton - the shared affordance', () => {
  it('renders the gated default wiring, so a nav can mount it with no bespoke handler', () => {
    render(
      <Wrapper>
        <ManageKnowledgeButton />
      </Wrapper>
    );

    fireEvent.click(screen.getByTestId('datalake-manage-btn'));
    expect(openManager).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when the user may not manage', () => {
    render(
      <Wrapper>
        <ManageKnowledgeButton requireAdmin />
      </Wrapper>
    );

    expect(screen.queryByTestId('datalake-manage-btn')).not.toBeInTheDocument();
  });

  it('uses a handler override as given, since that caller already gated it', () => {
    // The Explorer's case: it was handed a manage handler by a surface that decided
    // the affordance applies, and the button must not second-guess that decision.
    isAdminFeatureEnabled.mockReturnValue(false);
    const onManage = vi.fn();

    render(
      <Wrapper>
        <ManageKnowledgeButton onManage={onManage} />
      </Wrapper>
    );

    fireEvent.click(screen.getByTestId('datalake-manage-btn'));
    expect(onManage).toHaveBeenCalledTimes(1);
    expect(openManager).not.toHaveBeenCalled();
  });

  it('labels from the surface copy token by default and accepts an override', () => {
    const { rerender } = render(
      <Wrapper>
        <ManageKnowledgeButton />
      </Wrapper>
    );
    expect(screen.getByTestId('datalake-manage-btn')).toHaveTextContent('Manage lakes');

    rerender(
      <Wrapper>
        <ManageKnowledgeButton label="Manage knowledge" />
      </Wrapper>
    );
    expect(screen.getByTestId('datalake-manage-btn')).toHaveTextContent('Manage knowledge');
  });
});
