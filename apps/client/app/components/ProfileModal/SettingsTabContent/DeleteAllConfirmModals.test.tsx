import React from 'react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { DeleteAllKnowledgeFilesConfirm, DeleteAllNotebooksConfirm } from './DeleteAllConfirmModals';

const sessionCount: { data: number | undefined } = { data: undefined };
const fabFiles: { data: { pages: { total: number }[] } | undefined } = { data: undefined };

vi.mock('@client/app/hooks/data/sessions', () => ({ useOwnSessionCount: () => sessionCount }));
vi.mock('@client/app/hooks/data/fabFiles', () => ({ useGetFabFiles: () => fabFiles }));

const appTheme = extendTheme({ ...getThemeConfig() });
const wrap = (ui: React.ReactElement) => render(<CssVarsProvider theme={appTheme}>{ui}</CssVarsProvider>);
const props = () => ({ onCancel: vi.fn(), onConfirm: vi.fn(), pending: false });

describe('DeleteAllNotebooksConfirm', () => {
  beforeEach(() => {
    sessionCount.data = undefined;
  });

  it('names notebooks, not sessions, in the title and the confirm button', () => {
    wrap(<DeleteAllNotebooksConfirm {...props()} />);
    const dialog = screen.getByTestId('delete-all-notebooks-confirm');
    expect(dialog.textContent).toContain('Delete all notebooks');
    expect(dialog.textContent).not.toMatch(/session/i);
    expect(screen.getByTestId('confirm-modal-confirm-btn').textContent).toBe('Delete all notebooks');
  });

  it('states the count and the scope', () => {
    sessionCount.data = 12;
    wrap(<DeleteAllNotebooksConfirm {...props()} />);
    const text = screen.getByTestId('delete-all-notebooks-confirm').textContent;
    expect(text).toContain('This deletes 12 notebooks you own');
    expect(text).toContain('inside projects');
    expect(text).toContain('Notebooks others shared with you');
    expect(text).toContain('stay online');
    expect(text).toContain('cannot be undone');
  });

  it('uses the singular for one notebook and falls back while the count loads', () => {
    sessionCount.data = 1;
    const { unmount } = wrap(<DeleteAllNotebooksConfirm {...props()} />);
    expect(screen.getByTestId('delete-all-notebooks-confirm').textContent).toContain('This deletes 1 notebook you own');
    unmount();
    sessionCount.data = undefined;
    wrap(<DeleteAllNotebooksConfirm {...props()} />);
    expect(screen.getByTestId('delete-all-notebooks-confirm').textContent).toContain('This deletes all your notebooks');
  });

  it('wires cancel and confirm', () => {
    const p = props();
    wrap(<DeleteAllNotebooksConfirm {...p} />);
    fireEvent.click(screen.getByTestId('confirm-modal-cancel-btn'));
    fireEvent.click(screen.getByTestId('confirm-modal-confirm-btn'));
    expect(p.onCancel).toHaveBeenCalledTimes(1);
    expect(p.onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe('DeleteAllKnowledgeFilesConfirm', () => {
  beforeEach(() => {
    fabFiles.data = undefined;
  });

  it('names knowledge files in the title and the confirm button', () => {
    wrap(<DeleteAllKnowledgeFilesConfirm {...props()} />);
    expect(screen.getByTestId('delete-all-files-confirm').textContent).toContain('Delete all knowledge files');
    expect(screen.getByTestId('confirm-modal-confirm-btn').textContent).toBe('Delete all knowledge files');
  });

  it('states the list count and what else goes', () => {
    fabFiles.data = { pages: [{ total: 7 }] };
    wrap(<DeleteAllKnowledgeFilesConfirm {...props()} />);
    const text = screen.getByTestId('delete-all-files-confirm').textContent;
    expect(text).toContain('This deletes the 7 knowledge files in your list');
    expect(text).toContain('archived data lakes');
    expect(text).toContain('attached to projects or notebooks');
    expect(text).toContain('Files others shared with you are only removed from your list');
    expect(text).toContain('cannot be undone');
  });

  it('disables confirm while the delete is pending', () => {
    wrap(<DeleteAllKnowledgeFilesConfirm {...props()} pending />);
    expect((screen.getByTestId('confirm-modal-confirm-btn') as HTMLButtonElement).disabled).toBe(true);
  });
});
