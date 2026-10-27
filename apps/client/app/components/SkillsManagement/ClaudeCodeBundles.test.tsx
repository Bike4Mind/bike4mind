import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import ClaudeCodeBundles from './ClaudeCodeBundles';

const h = vi.hoisted(() => ({
  view: { bundles: [] as object[], listings: [] as object[], canEdit: false },
  save: vi.fn(),
  remove: vi.fn(),
}));
vi.mock('@client/app/hooks/data/skillMarket', () => ({
  useSkillBundles: () => ({ data: h.view, isPending: false, isError: false }),
  useSaveSkillBundle: () => ({ mutate: h.save, isPending: false }),
  useDeleteSkillBundle: () => ({ mutate: h.remove, isPending: false }),
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
  h.view = { bundles: [bundle], listings, canEdit: false };
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

  it('lets an admin edit members and delete a bundle', async () => {
    h.view = { ...h.view, canEdit: true };
    renderBundles();
    fireEvent.click(screen.getByLabelText('Edit bundle'));
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

  it('needs a name, description and at least one skill to create', () => {
    h.view = { bundles: [], listings, canEdit: true };
    renderBundles();
    fireEvent.click(screen.getByTestId('skill-claude-code-bundle-new'));
    fireEvent.change(screen.getByTestId('skill-claude-code-bundle-name'), { target: { value: 'Pack' } });
    fireEvent.change(screen.getByTestId('skill-claude-code-bundle-description'), { target: { value: 'd' } });
    expect(screen.getByTestId('skill-claude-code-bundle-save')).toBeDisabled();
  });

  it('renders nothing for a member when the org has no bundles', () => {
    h.view = { bundles: [], listings, canEdit: false };
    renderBundles();
    expect(screen.queryByTestId('skill-claude-code-bundles')).not.toBeInTheDocument();
  });
});
