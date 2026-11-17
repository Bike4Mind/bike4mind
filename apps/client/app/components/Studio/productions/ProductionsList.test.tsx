import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioCompositionSummaryResponse } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({
  list: { isPending: false, isError: false, error: null, data: [] as StudioCompositionSummaryResponse[] },
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, params, children, ...rest }: { to: string; params?: Record<string, string>; children: ReactNode }) => (
    <a href={to.replace('$compositionId', params?.compositionId ?? '')} {...rest}>
      {children}
    </a>
  ),
  useNavigate: () => h.navigate,
}));
vi.mock('@client/app/hooks/data/studioCompositions', () => ({
  compositionErrorMessage: () => 'failed',
  useStudioCompositions: () => h.list,
  useCreateStudioComposition: () => ({ mutate: h.create, isPending: false }),
  useUpdateStudioComposition: () => ({ mutate: h.update, isPending: false }),
  useDeleteStudioComposition: () => ({ mutateAsync: h.remove, isPending: false }),
}));
vi.mock('@client/app/components/common/ConfirmationModal', () => ({
  default: ({ open, onConfirm }: { open: boolean; onConfirm: () => void }) =>
    open ? (
      <button type="button" data-testid="confirmation-confirm-btn" onClick={onConfirm}>
        Confirm
      </button>
    ) : null,
}));

import ProductionsList from './ProductionsList';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const ID = 'c'.repeat(24);
const summary: StudioCompositionSummaryResponse = {
  id: ID,
  title: 'Spring ad',
  template: 'ad_campaign',
  brief: {},
  brandKit: { colors: [], productFileIds: [] },
  createdAt: new Date('2026-11-01T10:00:00Z'),
  updatedAt: new Date('2026-11-02T10:00:00Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
  h.list = { isPending: false, isError: false, error: null, data: [] };
});

describe('ProductionsList', () => {
  it('shows an empty state when the user has no productions', () => {
    render(<ProductionsList />, { wrapper: TestWrapper });
    expect(screen.getByTestId('productions-list-empty')).toBeInTheDocument();
  });

  it('creates a production from the title and template, then opens it', () => {
    render(<ProductionsList />, { wrapper: TestWrapper });
    expect(screen.getByTestId('productions-create-btn')).toBeDisabled();

    fireEvent.change(screen.getByTestId('productions-create-title-input'), { target: { value: '  Launch  ' } });
    fireEvent.click(screen.getByTestId('productions-create-btn'));

    expect(h.create).toHaveBeenCalledWith({ title: 'Launch', template: 'ad_campaign' }, expect.anything());
    const { onSuccess } = h.create.mock.calls[0][1];
    onSuccess({ id: ID });
    expect(h.navigate).toHaveBeenCalledWith({
      to: '/studio/productions/$compositionId',
      params: { compositionId: ID },
    });
  });

  it('links each production to its editor', () => {
    h.list.data = [summary];
    render(<ProductionsList />, { wrapper: TestWrapper });
    expect(screen.getByTestId(`productions-row-${ID}-open-link`)).toHaveAttribute('href', `/studio/productions/${ID}`);
  });

  it('renames a production', () => {
    h.list.data = [summary];
    render(<ProductionsList />, { wrapper: TestWrapper });
    fireEvent.click(screen.getByTestId(`productions-row-${ID}-rename-btn`));
    fireEvent.change(screen.getByTestId(`productions-row-${ID}-rename-input`), { target: { value: 'Summer ad' } });
    fireEvent.click(screen.getByTestId(`productions-row-${ID}-rename-save-btn`));
    expect(h.update).toHaveBeenCalledWith({ title: 'Summer ad' }, expect.anything());
  });

  it('deletes a production only after confirming', () => {
    h.list.data = [summary];
    render(<ProductionsList />, { wrapper: TestWrapper });
    expect(screen.queryByTestId('confirmation-confirm-btn')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId(`productions-row-${ID}-delete-btn`));
    expect(h.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('confirmation-confirm-btn'));
    expect(h.remove).toHaveBeenCalledWith(ID);
  });
});
