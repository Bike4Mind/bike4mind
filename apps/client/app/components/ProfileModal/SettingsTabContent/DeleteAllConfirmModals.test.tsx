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
const typeWord = (value: string) =>
  fireEvent.change(screen.getByTestId('delete-all-confirm-input'), { target: { value } });
const confirmBtn = () => screen.getByTestId('confirm-modal-confirm-btn') as HTMLButtonElement;

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
    expect(text).toContain('Pages you published from these notebooks are taken down too');
    expect(text).not.toContain('stay online');
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
    typeWord('DELETE');
    fireEvent.click(screen.getByTestId('confirm-modal-confirm-btn'));
    expect(p.onCancel).toHaveBeenCalledTimes(1);
    expect(p.onConfirm).toHaveBeenCalledTimes(1);
  });

  it('makes cancel inert while the delete is pending', () => {
    const p = props();
    wrap(<DeleteAllNotebooksConfirm {...p} pending />);
    fireEvent.click(screen.getByTestId('confirm-modal-cancel-btn'));
    expect(p.onCancel).not.toHaveBeenCalled();
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
    expect(text).toContain('Pages you published from these files are taken down too');
    expect(text).not.toContain('stay online');
    expect(text).toContain('cannot be undone');
  });

  it('disables confirm and makes cancel inert while the delete is pending', () => {
    const p = props();
    wrap(<DeleteAllKnowledgeFilesConfirm {...p} pending />);
    expect((screen.getByTestId('confirm-modal-confirm-btn') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('confirm-modal-cancel-btn'));
    expect(p.onCancel).not.toHaveBeenCalled();
  });
});

describe.each([
  ['DeleteAllNotebooksConfirm', DeleteAllNotebooksConfirm],
  ['DeleteAllKnowledgeFilesConfirm', DeleteAllKnowledgeFilesConfirm],
])('%s typed confirmation', (_name, Dialog) => {
  it('labels the field with the word to type', () => {
    wrap(<Dialog {...props()} />);
    expect(screen.getByLabelText('Type DELETE to confirm')).toBe(screen.getByTestId('delete-all-confirm-input'));
  });

  it('keeps the delete button disabled until the exact word is typed', () => {
    const p = props();
    wrap(<Dialog {...p} />);
    expect(confirmBtn().disabled).toBe(true);
    fireEvent.click(confirmBtn());
    expect(p.onConfirm).not.toHaveBeenCalled();

    typeWord('DELET');
    expect(confirmBtn().disabled).toBe(true);
    typeWord('DELETE');
    expect(confirmBtn().disabled).toBe(false);
    fireEvent.click(confirmBtn());
    expect(p.onConfirm).toHaveBeenCalledTimes(1);
  });

  it.each(['delete', 'Delete', ' DELETE', 'DELETE '])('is case- and whitespace-sensitive: rejects %j', value => {
    wrap(<Dialog {...props()} />);
    typeWord(value);
    expect(confirmBtn().disabled).toBe(true);
  });

  it('stays disabled while the delete is pending even with the word typed', () => {
    const { rerender } = wrap(<Dialog {...props()} />);
    typeWord('DELETE');
    rerender(
      <CssVarsProvider theme={appTheme}>
        <Dialog {...props()} pending />
      </CssVarsProvider>
    );
    expect(confirmBtn().disabled).toBe(true);
  });
});
