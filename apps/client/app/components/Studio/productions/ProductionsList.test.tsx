import type { ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultStudioTimeline, type StudioCompositionSummaryResponse } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({
  list: { isPending: false, isError: false, error: null, data: [] as StudioCompositionSummaryResponse[] },
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  navigate: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { error: h.toastError } }));

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
  default: ({ open, onConfirm, onClose }: { open: boolean; onConfirm: () => void; onClose: () => void }) =>
    open ? (
      <>
        <button type="button" data-testid="confirmation-confirm-btn" onClick={onConfirm}>
          Confirm
        </button>
        <button type="button" data-testid="confirmation-close-btn" onClick={onClose}>
          Close
        </button>
      </>
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

  it('offers every template as data, defaulting to Ad campaign, and creates from the one picked', () => {
    render(<ProductionsList />, { wrapper: TestWrapper });
    expect(screen.getByTestId('productions-template-ad_campaign')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('productions-template-ad_campaign')).toHaveTextContent('15s, 16:9 + 9:16 + 1:1');

    fireEvent.click(screen.getByTestId('productions-template-explainer'));
    expect(screen.getByTestId('productions-template-explainer')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('productions-template-ad_campaign')).toHaveAttribute('aria-checked', 'false');

    fireEvent.change(screen.getByTestId('productions-create-title-input'), { target: { value: 'How it works' } });
    fireEvent.click(screen.getByTestId('productions-create-btn'));
    expect(h.create).toHaveBeenCalledWith({ title: 'How it works', template: 'explainer' }, expect.anything());
  });

  it('shows the short film brief only while the Short film template is picked', () => {
    render(<ProductionsList />, { wrapper: TestWrapper });
    expect(screen.queryByTestId('productions-short-film-brief')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('productions-template-short_film'));
    expect(screen.getByTestId('productions-short-film-brief')).toBeInTheDocument();
    expect(screen.getByTestId('productions-create-btn')).toHaveTextContent('Create short film');
    fireEvent.click(screen.getByTestId('productions-template-ad_campaign'));
    expect(screen.queryByTestId('productions-short-film-brief')).not.toBeInTheDocument();
  });

  it('creates a short film from its premise, tone, length and sizes', () => {
    render(<ProductionsList />, { wrapper: TestWrapper });
    fireEvent.click(screen.getByTestId('productions-template-short_film'));
    fireEvent.change(screen.getByTestId('productions-create-title-input'), { target: { value: 'The Keeper' } });
    fireEvent.change(screen.getByTestId('productions-short-film-premise-input'), {
      target: { value: '  A lighthouse keeper finds a message  ' },
    });
    fireEvent.change(screen.getByTestId('productions-short-film-tone-input'), { target: { value: ' wistful ' } });
    fireEvent.click(screen.getByTestId('productions-short-film-length-90s'));
    // Checked out of order; the outputs still follow the shared aspect order.
    fireEvent.click(screen.getByTestId('productions-short-film-aspect-1x1-checkbox'));
    fireEvent.click(screen.getByTestId('productions-short-film-aspect-16x9-checkbox'));
    fireEvent.click(screen.getByTestId('productions-short-film-aspect-9x16-checkbox'));
    fireEvent.click(screen.getByTestId('productions-create-btn'));

    expect(h.create).toHaveBeenCalledWith(
      {
        title: 'The Keeper',
        template: 'short_film',
        brief: { summary: 'A lighthouse keeper finds a message', tone: 'wistful' },
        timeline: defaultStudioTimeline('short_film', { durationMs: 90_000, aspects: ['9:16', '1:1'] }),
      },
      expect.anything()
    );
  });

  it('starts a short film at the template length in 16:9 and leaves out an empty premise and tone', () => {
    render(<ProductionsList />, { wrapper: TestWrapper });
    fireEvent.click(screen.getByTestId('productions-template-short_film'));
    // Clicking the selected length again does not unset it.
    fireEvent.click(screen.getByTestId('productions-short-film-length-60s'));
    fireEvent.click(screen.getByTestId('productions-short-film-length-120s'));
    fireEvent.click(screen.getByTestId('productions-short-film-length-30s'));
    fireEvent.click(screen.getByTestId('productions-short-film-length-30s'));
    fireEvent.change(screen.getByTestId('productions-create-title-input'), { target: { value: 'Short' } });
    fireEvent.click(screen.getByTestId('productions-create-btn'));

    const [body] = h.create.mock.calls[0];
    expect(body.brief).toEqual({});
    expect(body.timeline.durationMs).toBe(30_000);
    expect(body.timeline.outputs.map((output: { aspectRatio: string }) => output.aspectRatio)).toEqual(['16:9']);
    expect(body.timeline.tracks.map((track: { kind: string }) => track.kind)).toContain('captions');
  });

  it('needs at least one size before a short film can be created', () => {
    render(<ProductionsList />, { wrapper: TestWrapper });
    fireEvent.click(screen.getByTestId('productions-template-short_film'));
    fireEvent.change(screen.getByTestId('productions-create-title-input'), { target: { value: 'No sizes' } });
    expect(screen.queryByTestId('productions-short-film-aspects-error')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('productions-short-film-aspect-16x9-checkbox'));
    expect(screen.getByTestId('productions-short-film-aspects-error')).toBeInTheDocument();
    expect(screen.getByTestId('productions-create-btn')).toBeDisabled();
    fireEvent.submit(screen.getByTestId('productions-create-title-input'));
    expect(h.create).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('productions-short-film-aspect-4x5-checkbox'));
    expect(screen.getByTestId('productions-create-btn')).toBeEnabled();
  });

  it('does not create from a blank name submitted with Enter', () => {
    render(<ProductionsList />, { wrapper: TestWrapper });
    fireEvent.submit(screen.getByTestId('productions-create-title-input'));
    expect(h.create).not.toHaveBeenCalled();
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

  it('shows a spinner while loading and the error when the list fails', () => {
    h.list = { ...h.list, isPending: true };
    const { unmount } = render(<ProductionsList />, { wrapper: TestWrapper });
    expect(screen.getByTestId('productions-list-loading')).toBeInTheDocument();
    unmount();
    h.list = { ...h.list, isPending: false, isError: true };
    render(<ProductionsList />, { wrapper: TestWrapper });
    expect(screen.getByTestId('productions-list-error')).toHaveTextContent('failed');
  });

  it('closes the rename without saving an unchanged or blank title, or on cancel', () => {
    h.list.data = [summary];
    render(<ProductionsList />, { wrapper: TestWrapper });
    for (const value of ['  Spring ad ', '   ']) {
      fireEvent.click(screen.getByTestId(`productions-row-${ID}-rename-btn`));
      fireEvent.change(screen.getByTestId(`productions-row-${ID}-rename-input`), { target: { value } });
      fireEvent.click(screen.getByTestId(`productions-row-${ID}-rename-save-btn`));
      expect(screen.queryByTestId(`productions-row-${ID}-rename-input`)).not.toBeInTheDocument();
    }
    fireEvent.click(screen.getByTestId(`productions-row-${ID}-rename-btn`));
    fireEvent.click(screen.getByTestId(`productions-row-${ID}-rename-cancel-btn`));
    expect(screen.queryByTestId(`productions-row-${ID}-rename-input`)).not.toBeInTheDocument();
    expect(h.update).not.toHaveBeenCalled();
  });

  it('closes the rename once saved and reports a failed save', () => {
    h.list.data = [summary];
    render(<ProductionsList />, { wrapper: TestWrapper });
    fireEvent.click(screen.getByTestId(`productions-row-${ID}-rename-btn`));
    fireEvent.change(screen.getByTestId(`productions-row-${ID}-rename-input`), { target: { value: 'Summer ad' } });
    fireEvent.click(screen.getByTestId(`productions-row-${ID}-rename-save-btn`));
    const { onSuccess, onError } = h.update.mock.calls[0][1];
    onError(new Error('nope'));
    expect(h.toastError).toHaveBeenCalledWith('failed');
    act(() => onSuccess());
    expect(screen.queryByTestId(`productions-row-${ID}-rename-input`)).not.toBeInTheDocument();
  });

  it('closes the delete confirmation once deleted, or when dismissed', async () => {
    h.list.data = [summary];
    h.remove.mockResolvedValue(undefined);
    render(<ProductionsList />, { wrapper: TestWrapper });
    fireEvent.click(screen.getByTestId(`productions-row-${ID}-delete-btn`));
    fireEvent.click(screen.getByTestId('confirmation-close-btn'));
    expect(screen.queryByTestId('confirmation-confirm-btn')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId(`productions-row-${ID}-delete-btn`));
    await act(async () => {
      fireEvent.click(screen.getByTestId('confirmation-confirm-btn'));
    });
    expect(screen.queryByTestId('confirmation-confirm-btn')).not.toBeInTheDocument();
  });
});
