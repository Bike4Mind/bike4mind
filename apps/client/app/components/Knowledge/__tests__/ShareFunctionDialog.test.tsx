import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { ICallableFunctionPublic } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  share: { data: undefined as unknown, isPending: false, isError: false },
  save: { mutate: vi.fn(), isPending: false },
  lookup: vi.fn(),
}));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: {} }));
vi.mock('@client/app/hooks/data/callableFunctions', async importOriginal => ({
  ...(await importOriginal<typeof import('@client/app/hooks/data/callableFunctions')>()),
  useCallableFunctionShare: () => h.share,
  useShareCallableFunction: () => h.save,
}));
vi.mock('@client/app/hooks/data/skills', () => ({ lookupUserByEmail: h.lookup }));
vi.mock('@client/app/hooks/data/projects', () => ({
  useGetJoinedProjects: () => ({
    data: [
      { id: 'project-1', name: 'Bridges', userId: 'owner-1', users: [] },
      { id: 'project-2', name: 'Named', userId: 'someone', users: [{ userId: 'owner-1', permissions: ['read'] }] },
      { id: 'project-3', name: 'Group only', userId: 'someone', users: [] },
    ],
  }),
}));
vi.mock('@client/app/hooks/data/organizations', () => ({
  useGetUserOrganizations: () => ({ data: [{ id: 'org-1', name: 'Structures' }] }),
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (select: (s: { currentUser: { id: string } }) => unknown) => select({ currentUser: { id: 'owner-1' } }),
}));

import ShareFunctionDialog, { shareDataSentence } from '../ShareFunctionDialog';

const appTheme = extendTheme({ ...getThemeConfig() });

const TOOL = {
  id: 'fn-1',
  slug: 'beam_midspan_deflection',
  state: 'live',
  status: 'live',
  pin: { artifactId: 'artifact-1', version: 5, contentHash: 'a'.repeat(64), pinnedAt: new Date(), seq: 2 },
  grants: null,
} as unknown as ICallableFunctionPublic;

const renderDialog = (props: Partial<React.ComponentProps<typeof ShareFunctionDialog>> = {}) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <ShareFunctionDialog tool={TOOL} dataPins={[]} sources={[]} onClose={vi.fn()} {...props} />
    </CssVarsProvider>
  );

beforeEach(() => {
  h.share = { data: { grants: null, people: [] }, isPending: false, isError: false };
  h.save.mutate.mockReset();
  h.lookup.mockReset();
});

describe('shareDataSentence', () => {
  it('names each data file and source, or says there are none', () => {
    expect(shareDataSentence([], [])).toContain('reads no pinned data files and no sources');
    expect(shareDataSentence(['loads.csv', 'spans.csv', 'steel.csv'], ['https://data.example.com/beams'])).toContain(
      'the data files loads.csv, spans.csv, and steel.csv, and the source https://data.example.com/beams'
    );
  });

  it('uses the singular for one data file or one source', () => {
    expect(shareDataSentence(['loads.csv'], [])).toContain('reads the data file loads.csv and no sources.');
    expect(shareDataSentence([], ['https://data.example.com/beams'])).toContain(
      'reads no pinned data files and the source https://data.example.com/beams.'
    );
  });

  it('joins a list of files and a list of sources with a comma before and', () => {
    expect(shareDataSentence(['factors.csv', 'limits.csv'], ['rates.csv'])).toContain(
      'which reads the data files factors.csv and limits.csv, and the source rates.csv.'
    );
    expect(shareDataSentence(['factors.csv'], ['rates.csv'])).toContain(
      'which reads the data file factors.csv, and the source rates.csv.'
    );
  });
});

describe('ShareFunctionDialog', () => {
  it('lists the data the function reads and the sentence the owner confirms', () => {
    renderDialog({ dataPins: ['loads.csv'], sources: ['https://data.example.com/beams'] });
    expect(screen.getAllByTestId('python-function-share-data-item').map(item => item.textContent)).toEqual([
      'Data file: loads.csv',
      'Source: https://data.example.com/beams',
    ]);
    expect(screen.getByTestId('python-function-share-sentence').textContent).toContain(
      'cannot see its code or open the artifact'
    );
  });

  it('keeps Share off until the owner confirms the sentence and names a recipient', async () => {
    h.lookup.mockResolvedValue({ id: 'person-1', name: 'Person One' });
    renderDialog();
    const submit = screen.getByTestId('python-function-share-submit-btn');
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByTestId('python-function-share-email'), { target: { value: 'one@example.com' } });
    fireEvent.click(screen.getByTestId('python-function-share-add-btn'));
    await waitFor(() => expect(screen.getByTestId('python-function-share-person').textContent).toBe('Person One'));
    expect(submit).toBeDisabled();

    fireEvent.click(screen.getByTestId('python-function-share-confirm'));
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);
    expect(h.save.mutate).toHaveBeenCalledWith(
      { id: 'fn-1', visibility: 'private', userIds: ['person-1'] },
      expect.anything()
    );
  });

  it('says the share follows the live version, and that a project share reaches its named people', () => {
    renderDialog();
    expect(screen.getByTestId('python-function-share-dialog').textContent).toContain(
      'Shares the live version, now promotion 2; a later promotion is shared too.'
    );
    expect(screen.queryByTestId('python-function-share-project-note')).toBeNull();
    fireEvent.click(screen.getByTestId('python-function-share-visibility-project'));
    expect(screen.getByTestId('python-function-share-project-note').textContent).toBe(
      'Reaches the people named on the project, not the groups it is shared with.'
    );
  });

  it('sends the organization chosen and the people already named', () => {
    h.share = {
      data: {
        grants: { visibility: 'organization', organizationId: 'org-1', userIds: ['person-2'] },
        people: [{ id: 'person-2', name: 'Person Two' }],
      },
      isPending: false,
      isError: false,
    };
    renderDialog();
    expect(screen.getByTestId('python-function-share-visibility-organization')).toBeChecked();
    fireEvent.click(screen.getByTestId('python-function-share-confirm'));
    fireEvent.click(screen.getByTestId('python-function-share-submit-btn'));
    expect(h.save.mutate).toHaveBeenCalledWith(
      { id: 'fn-1', visibility: 'organization', organizationId: 'org-1', userIds: ['person-2'] },
      expect.anything()
    );
  });

  it('says so when no account uses the address, and adds nobody', async () => {
    h.lookup.mockResolvedValue(null);
    renderDialog();
    fireEvent.change(screen.getByTestId('python-function-share-email'), { target: { value: 'nobody@example.com' } });
    fireEvent.click(screen.getByTestId('python-function-share-add-btn'));
    await waitFor(() =>
      expect(screen.getByTestId('python-function-share-error').textContent).toBe('No account uses nobody@example.com.')
    );
    expect(screen.queryByTestId('python-function-share-person')).toBeNull();
  });

  it('stops adding people at 50', () => {
    h.share = {
      data: {
        grants: { visibility: 'private', userIds: [] },
        people: Array.from({ length: 50 }, (_, i) => ({ id: `p-${i}`, name: `Person ${i}` })),
      },
      isPending: false,
      isError: false,
    };
    renderDialog();
    expect(screen.getByTestId('python-function-share-email')).toBeDisabled();
    expect(screen.getByText('People (50 of 50)')).toBeTruthy();
  });

  it('shows why the share could not be saved, and stays open', () => {
    const onClose = vi.fn();
    h.share = {
      data: { grants: null, people: [{ id: 'person-1', name: 'Person One' }] },
      isPending: false,
      isError: false,
    };
    h.save.mutate.mockImplementation((_input, options) => options.onError(new Error('Request failed')));
    renderDialog({ onClose });
    fireEvent.click(screen.getByTestId('python-function-share-confirm'));
    fireEvent.click(screen.getByTestId('python-function-share-submit-btn'));
    expect(screen.getByTestId('python-function-share-error').textContent).toBe('The tool could not be shared.');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes once the share is saved', () => {
    const onClose = vi.fn();
    h.share = {
      data: { grants: null, people: [{ id: 'person-1', name: 'Person One' }] },
      isPending: false,
      isError: false,
    };
    h.save.mutate.mockImplementation((_input, options) => options.onSuccess());
    renderDialog({ onClose });
    fireEvent.click(screen.getByTestId('python-function-share-confirm'));
    fireEvent.click(screen.getByTestId('python-function-share-submit-btn'));
    expect(onClose).toHaveBeenCalled();
  });

  it('says so when the address could not be looked up, and adds nobody', async () => {
    h.lookup.mockRejectedValue(new Error('network'));
    renderDialog();
    fireEvent.change(screen.getByTestId('python-function-share-email'), { target: { value: 'one@example.com' } });
    fireEvent.click(screen.getByTestId('python-function-share-add-btn'));
    await waitFor(() =>
      expect(screen.getByTestId('python-function-share-error').textContent).toBe('That address could not be looked up.')
    );
    expect(screen.queryByTestId('python-function-share-person')).toBeNull();
  });

  it('says so when the share could not be loaded, and shows no form', () => {
    h.share = { data: undefined, isPending: false, isError: true };
    renderDialog();
    expect(screen.getByTestId('python-function-share-load-error').textContent).toBe('The share could not be loaded.');
    expect(screen.queryByTestId('python-function-share-submit-btn')).toBeNull();
  });

  it('offers only the projects the owner owns or is named on', () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('python-function-share-visibility-project'));
    fireEvent.click(screen.getByRole('combobox'));
    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['Bridges', 'Named']);
  });
});
