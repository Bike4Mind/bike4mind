import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import ClaudeCodeBundles from './ClaudeCodeBundles';

const h = vi.hoisted(() => ({
  view: { bundles: [] as object[], listings: [] as object[], canEdit: false } as object | undefined,
  loadFailed: false,
  save: vi.fn(),
  remove: vi.fn(),
  removeError: undefined as Error | undefined,
}));
vi.mock('@client/app/hooks/data/skillMarket', () => ({
  useSkillBundles: () => ({ data: h.loadFailed ? undefined : h.view, isPending: false, isError: h.loadFailed }),
  useSaveSkillBundle: () => ({ mutate: h.save, isPending: false }),
  useDeleteSkillBundle: () => ({
    mutate: h.remove,
    isPending: false,
    isError: Boolean(h.removeError),
    error: h.removeError,
  }),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const renderBundles = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <ClaudeCodeBundles orgId="org1" marketplace="b4m-org-org1" />
    </CssVarsProvider>
  );

const bundle = {
  id: 'b1',
  organizationId: 'org1',
  name: 'Starter pack',
  description: 'Day one skills',
  pluginName: 'starter-pack',
  listingIds: ['l1', 'l2'],
};
const listings = [
  { id: 'l1', name: 'review-pr', pluginName: 'review-pr' },
  { id: 'l2', name: 'lint', pluginName: 'lint' },
];

beforeEach(() => {
  vi.clearAllMocks();
  h.loadFailed = false;
  h.removeError = undefined;
  h.view = { bundles: [bundle], listings, canEdit: false };
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('ClaudeCodeBundles', () => {
  it('shows members the install command, without edit controls', () => {
    renderBundles();
    expect(screen.getByTestId('skill-claude-code-bundle-install')).toHaveTextContent(
      '/plugin install starter-pack@b4m-org-org1'
    );
    expect(screen.getByTestId('skill-claude-code-bundle')).toHaveTextContent('2 skills');
    expect(screen.queryByTestId('skill-claude-code-bundle-new')).not.toBeInTheDocument();
    expect(screen.queryByTestId('skill-claude-code-bundle-delete')).not.toBeInTheDocument();
  });

  it('counts only members still in the marketplace', () => {
    h.view = { ...h.view, listings: [listings[0]] };
    renderBundles();
    expect(screen.getByTestId('skill-claude-code-bundle')).toHaveTextContent('1 skill');
  });

  it('lets an admin edit members and delete a bundle', async () => {
    h.view = { ...h.view, canEdit: true };
    renderBundles();
    fireEvent.click(screen.getByTestId('skill-claude-code-bundle-edit'));
    expect(screen.getByTestId('skill-claude-code-bundle-editor')).toHaveTextContent(
      'The install name stays starter-pack'
    );
    fireEvent.change(screen.getByTestId('skill-claude-code-bundle-name'), { target: { value: 'Starter kit' } });
    fireEvent.click(screen.getByTestId('skill-claude-code-bundle-save'));
    expect(h.save).toHaveBeenCalledWith(
      { id: 'b1', name: 'Starter kit', description: 'Day one skills', listingIds: ['l1', 'l2'] },
      expect.anything()
    );

    // The editor closes once the save succeeds.
    act(() => h.save.mock.calls[0][1].onSuccess());
    fireEvent.click(await screen.findByTestId('skill-claude-code-bundle-delete'));
    expect(h.remove).toHaveBeenCalledWith('b1');
  });

  it('keeps a non-candidate member when saving an edited bundle', () => {
    h.view = { bundles: [bundle], listings: [listings[0]], canEdit: true };
    renderBundles();
    fireEvent.click(screen.getByTestId('skill-claude-code-bundle-edit'));
    fireEvent.change(screen.getByTestId('skill-claude-code-bundle-name'), { target: { value: 'Starter kit' } });
    fireEvent.click(screen.getByTestId('skill-claude-code-bundle-save'));
    expect(h.save).toHaveBeenCalledWith(
      { id: 'b1', name: 'Starter kit', description: 'Day one skills', listingIds: ['l2', 'l1'] },
      expect.anything()
    );
  });

  it('needs a name, description and at least one skill to create', () => {
    h.view = { bundles: [], listings, canEdit: true };
    renderBundles();
    fireEvent.click(screen.getByTestId('skill-claude-code-bundle-new'));
    fireEvent.change(screen.getByTestId('skill-claude-code-bundle-name'), { target: { value: 'Pack' } });
    fireEvent.change(screen.getByTestId('skill-claude-code-bundle-description'), { target: { value: 'd' } });
    expect(screen.getByTestId('skill-claude-code-bundle-save')).toBeDisabled();
  });

  it('creates a bundle: a new one saves without an id and the picked skills', async () => {
    h.view = { bundles: [], listings, canEdit: true };
    renderBundles();
    fireEvent.click(screen.getByTestId('skill-claude-code-bundle-new'));
    fireEvent.change(screen.getByTestId('skill-claude-code-bundle-name'), { target: { value: 'Pack' } });
    fireEvent.change(screen.getByTestId('skill-claude-code-bundle-description'), { target: { value: 'd' } });
    const picker = screen.getByTestId('skill-claude-code-bundle-skills');
    fireEvent.mouseDown(picker);
    fireEvent.click(await screen.findByText('review-pr'));
    fireEvent.click(screen.getByTestId('skill-claude-code-bundle-save'));
    expect(h.save).toHaveBeenCalledWith(
      { id: undefined, name: 'Pack', description: 'd', listingIds: ['l1'] },
      expect.anything()
    );
  });

  it('shows the save error in the editor', async () => {
    h.view = { ...(h.view as object), canEdit: true };
    renderBundles();
    fireEvent.click(screen.getByTestId('skill-claude-code-bundle-edit'));
    fireEvent.click(screen.getByTestId('skill-claude-code-bundle-save'));
    act(() => h.save.mock.calls[0][1].onError(new Error('Name already taken')));
    expect(await screen.findByTestId('skill-claude-code-bundle-error')).toHaveTextContent('Name already taken');
  });

  it('shows a load failure', () => {
    h.loadFailed = true;
    renderBundles();
    expect(screen.getByText('Could not load bundles.')).toBeInTheDocument();
  });

  it('asks before deleting and shows a failed delete', () => {
    h.view = { ...(h.view as object), canEdit: true };
    h.removeError = new Error('Forbidden');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderBundles();
    fireEvent.click(screen.getByTestId('skill-claude-code-bundle-delete'));
    expect(confirm).toHaveBeenCalled();
    expect(h.remove).not.toHaveBeenCalled();
    expect(screen.getByTestId('skill-claude-code-bundle-delete-error')).toHaveTextContent('Forbidden');
  });

  it('says a bundle with no approved members is not in the feed', () => {
    h.view = { ...(h.view as object), listings: [] };
    renderBundles();
    expect(screen.queryByTestId('skill-claude-code-bundle-install')).not.toBeInTheDocument();
    expect(screen.getByTestId('skill-claude-code-bundle-not-in-feed')).toBeInTheDocument();
  });

  it('renders nothing for a member when the org has no bundles', () => {
    h.view = { bundles: [], listings, canEdit: false };
    renderBundles();
    expect(screen.queryByTestId('skill-claude-code-bundles')).not.toBeInTheDocument();
  });
});
