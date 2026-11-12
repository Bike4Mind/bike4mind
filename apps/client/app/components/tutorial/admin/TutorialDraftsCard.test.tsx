import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';

const current = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const mockMutate = vi.fn();
const download = vi.hoisted(() => vi.fn());
vi.mock('@client/app/hooks/tutorials/useTutorialDrafts', () => ({
  useTutorialDrafts: () => current.value,
  useTutorialDraftAction: () => ({ mutate: mockMutate, isPending: false }),
  TutorialDraftRefused: class extends Error {},
}));
vi.mock('./tutorialOverrideExport', () => ({ downloadModuleBundle: download }));

import TutorialDraftsCard from './TutorialDraftsCard';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderCard = (owner = 'core') =>
  render(
    <CssVarsProvider theme={appTheme}>
      <TutorialDraftsCard apiBase="/api/test-tutorials" owner={owner} />
    </CssVarsProvider>
  );

function draft(patch: Record<string, unknown> = {}) {
  return {
    moduleId: 'my-sites',
    title: 'Pick the sites',
    pitch: 'p',
    sourceSessionId: 's1',
    revision: 1,
    contentSeq: 3,
    approved: false,
    enabled: false,
    content: {
      moduleId: 'my-sites',
      title: 'Pick the sites',
      pitch: 'p',
      transcript: [{ prompt: 'Pick sites', reply: 'Sure.' }],
      steps: [],
      finale: { title: 'F', body: 'B' },
    },
    preview: [{ id: 'bridge', type: 'questFinale', title: 'The finale', body: 'Done' }],
    issues: [],
    lastChange: null,
    ...patch,
  };
}

const CHOICES = {
  anchors: [],
  anchorScopes: [],
  avoids: [],
  canvasTabs: [] as string[],
  stepTypes: ['prompt'],
  visibility: false,
};
const setDrafts = (drafts: unknown[], choices: Record<string, unknown> = {}) => {
  current.value = { data: { drafts, choices: { ...CHOICES, ...choices } }, isLoading: false, isError: false };
};
const fillCapture = () => {
  fireEvent.change(screen.getByTestId('tutorial-capture-session'), { target: { value: 'sess-1' } });
  fireEvent.change(screen.getByTestId('tutorial-capture-module-id'), { target: { value: 'my-sites' } });
  fireEvent.change(screen.getByTestId('tutorial-capture-title'), { target: { value: 'Pick the sites' } });
};
const chooseOption = (testid: string, label: string) => {
  fireEvent.click(screen.getByTestId(testid));
  fireEvent.click(screen.getByRole('option', { name: label }));
};
const openDraft = (drafts: unknown[] = [draft()], choices: Record<string, unknown> = {}) => {
  setDrafts(drafts, choices);
  const view = renderCard();
  fireEvent.click(screen.getByTestId('tutorial-draft-open-my-sites'));
  typeReason();
  return view;
};
const edit = (testid = 'tutorial-draft-pitch', value = 'edited') =>
  fireEvent.change(screen.getByTestId(testid), { target: { value } });
const typeReason = () =>
  fireEvent.change(screen.getByTestId('tutorial-drafts-reason'), { target: { value: 'checked it' } });

describe('TutorialDraftsCard', () => {
  beforeEach(() => {
    mockMutate.mockReset();
    download.mockReset();
  });

  it('captures a session with the id and title given', () => {
    setDrafts([]);
    renderCard();
    fireEvent.change(screen.getByTestId('tutorial-capture-session'), { target: { value: 'sess-1' } });
    fireEvent.change(screen.getByTestId('tutorial-capture-module-id'), { target: { value: 'my-sites' } });
    fireEvent.change(screen.getByTestId('tutorial-capture-title'), { target: { value: 'Pick the sites' } });
    fireEvent.click(screen.getByTestId('tutorial-capture-submit'));
    expect(mockMutate.mock.calls[0][0]).toMatchObject({
      action: 'capture',
      sessionId: 'sess-1',
      moduleId: 'my-sites',
      title: 'Pick the sites',
    });
  });

  it('shows the preview and approves it only with a reason', () => {
    setDrafts([draft()]);
    renderCard();
    fireEvent.click(screen.getByTestId('tutorial-draft-open-my-sites'));
    expect(screen.getByTestId('tutorial-draft-preview')).toHaveTextContent('The finale');
    expect(screen.getByTestId('tutorial-draft-approve')).toBeDisabled();
    typeReason();
    fireEvent.click(screen.getByTestId('tutorial-draft-approve'));
    expect(mockMutate.mock.calls[0][0]).toMatchObject({ action: 'approve', moduleId: 'my-sites', contentSeq: 3 });
  });

  it('keeps the switch off until the draft is approved, and approval off while rules fail', () => {
    setDrafts([draft({ issues: [{ rule: 'draft-params', message: 'set the proven best' }] })]);
    renderCard();
    fireEvent.click(screen.getByTestId('tutorial-draft-open-my-sites'));
    typeReason();
    expect(screen.getByTestId('tutorial-draft-issues')).toHaveTextContent('set the proven best');
    expect(screen.getByTestId('tutorial-draft-approve')).toBeDisabled();
    expect(screen.getByTestId('tutorial-draft-enable').querySelector('input')).toBeDisabled();
  });

  it('keeps capture disabled until a visibility is chosen, and sends the choice', () => {
    setDrafts([], { visibility: true });
    renderCard();
    fillCapture();
    expect(screen.getByTestId('tutorial-capture-submit')).toBeDisabled();
    chooseOption('tutorial-capture-visibility-kind', 'Entitlement key');
    expect(screen.getByTestId('tutorial-capture-submit')).toBeDisabled();
    fireEvent.change(screen.getByTestId('tutorial-capture-visibility-key'), { target: { value: 'pro:tools' } });
    expect(screen.getByTestId('tutorial-capture-submit')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('tutorial-capture-submit'));
    expect(mockMutate.mock.calls[0][0]).toMatchObject({ action: 'capture', visibility: { entitlement: 'pro:tools' } });
  });

  it('sends an explicit Everyone choice as public', () => {
    setDrafts([], { visibility: true });
    renderCard();
    fillCapture();
    chooseOption('tutorial-capture-visibility-kind', 'Everyone');
    fireEvent.click(screen.getByTestId('tutorial-capture-submit'));
    expect(mockMutate.mock.calls[0][0]).toMatchObject({ visibility: { public: true } });
  });

  it('does not ask for a visibility when the host does not require one', () => {
    setDrafts([]);
    renderCard();
    expect(screen.queryByTestId('tutorial-capture-visibility-kind')).not.toBeInTheDocument();
    fillCapture();
    fireEvent.click(screen.getByTestId('tutorial-capture-submit'));
    expect(mockMutate.mock.calls[0][0]).not.toHaveProperty('visibility');
  });

  it('saves a changed visibility on a draft', () => {
    setDrafts([draft({ content: { ...draft().content, visibility: { entitlement: 'pro:tools' } } })], {
      visibility: true,
    });
    renderCard();
    fireEvent.click(screen.getByTestId('tutorial-draft-open-my-sites'));
    typeReason();
    expect(screen.getByTestId('tutorial-draft-save')).toBeDisabled();
    fireEvent.change(screen.getByTestId('tutorial-draft-visibility-key'), { target: { value: 'pro:other' } });
    fireEvent.click(screen.getByTestId('tutorial-draft-save'));
    expect(mockMutate.mock.calls[0][0]).toMatchObject({ action: 'save', visibility: { entitlement: 'pro:other' } });
  });

  it('shows the canvas node field only when the host has canvas tabs', () => {
    setDrafts([draft()]);
    const { unmount } = renderCard();
    fireEvent.click(screen.getByTestId('tutorial-draft-open-my-sites'));
    expect(screen.queryByTestId('tutorial-draft-canvas-node')).not.toBeInTheDocument();
    unmount();
    setDrafts([draft()], { canvasTabs: ['opti'] });
    renderCard();
    fireEvent.click(screen.getByTestId('tutorial-draft-open-my-sites'));
    expect(screen.getByTestId('tutorial-draft-canvas-node')).toBeInTheDocument();
  });

  it('exports a bundle owned by the owner prop', () => {
    setDrafts([draft()]);
    renderCard();
    fireEvent.click(screen.getByTestId('tutorial-draft-open-my-sites'));
    fireEvent.click(screen.getByTestId('tutorial-draft-export'));
    expect(download).toHaveBeenCalledWith(expect.objectContaining({ moduleId: 'my-sites' }), 'core');
  });

  it('exports a bundle owned by alpha when the host owner is alpha', () => {
    setDrafts([draft()]);
    renderCard('alpha');
    fireEvent.click(screen.getByTestId('tutorial-draft-open-my-sites'));
    fireEvent.click(screen.getByTestId('tutorial-draft-export'));
    expect(download).toHaveBeenCalledWith(expect.objectContaining({ moduleId: 'my-sites' }), 'alpha');
  });

  describe('delete', () => {
    it('opens a type-the-name dialog and sends contentSeq and the dialog reason', () => {
      openDraft();
      fireEvent.click(screen.getByTestId('tutorial-draft-delete'));
      expect(mockMutate).not.toHaveBeenCalled();
      const confirm = screen.getByTestId('tutorial-draft-delete-dialog-confirm-btn');
      fireEvent.click(screen.getByTestId('tutorial-draft-delete-dialog-reason-input-preset-0'));
      expect(confirm).toBeDisabled();
      fireEvent.change(screen.getByTestId('tutorial-draft-delete-dialog-typed-input'), {
        target: { value: 'my-sites' },
      });
      fireEvent.click(confirm);
      expect(mockMutate.mock.calls[0][0]).toMatchObject({
        action: 'delete',
        moduleId: 'my-sites',
        contentSeq: 3,
        reason: 'Superseded by a newer draft',
      });
    });
  });

  describe('editing', () => {
    it('disables save until something changed, then sends only the changed fields', () => {
      openDraft();
      expect(screen.getByTestId('tutorial-draft-save')).toBeDisabled();
      edit();
      expect(screen.getByTestId('tutorial-draft-save')).not.toBeDisabled();
      fireEvent.click(screen.getByTestId('tutorial-draft-save'));
      const sent = mockMutate.mock.calls[0][0];
      expect(sent).toMatchObject({ action: 'save', contentSeq: 3, pitch: 'edited' });
      for (const key of ['title', 'finale', 'steps', 'replies', 'attachTurn', 'visibility']) {
        expect(sent).not.toHaveProperty(key);
      }
    });

    it('disables save while a changed reply is empty', () => {
      openDraft();
      edit('tutorial-draft-reply-0', '  ');
      expect(screen.getByTestId('tutorial-draft-save')).toBeDisabled();
      edit('tutorial-draft-reply-0', 'New reply');
      expect(screen.getByTestId('tutorial-draft-save')).not.toBeDisabled();
    });

    it('disables save when a required visibility is cleared', () => {
      openDraft([draft({ content: { ...draft().content, visibility: { entitlement: 'pro:tools' } } })], {
        visibility: true,
      });
      fireEvent.change(screen.getByTestId('tutorial-draft-visibility-key'), { target: { value: '' } });
      expect(screen.getByTestId('tutorial-draft-save')).toBeDisabled();
    });

    it('disables the sheet input and export while dirty, with a hint', () => {
      openDraft();
      expect(screen.getByTestId('tutorial-draft-sheet-input')).not.toBeDisabled();
      expect(screen.getByTestId('tutorial-draft-export')).not.toBeDisabled();
      expect(screen.queryByTestId('tutorial-draft-sheet-hint')).not.toBeInTheDocument();
      edit();
      expect(screen.getByTestId('tutorial-draft-sheet-input')).toBeDisabled();
      expect(screen.getByTestId('tutorial-draft-export')).toBeDisabled();
      expect(screen.getByTestId('tutorial-draft-sheet-hint')).toBeInTheDocument();
    });

    it('resets the file input after a pick so the same file can be chosen again', async () => {
      openDraft();
      const input = screen.getByTestId('tutorial-draft-sheet-input') as HTMLInputElement;
      const file = new File(['a,b\n1,2\n'], 'a.csv', { type: 'text/csv' });
      const values: string[] = [];
      Object.defineProperty(input, 'value', {
        configurable: true,
        get: () => '',
        set: (v: string) => values.push(v),
      });
      fireEvent.change(input, { target: { files: [file] } });
      expect(values).toContain('');
      await waitFor(() => expect(mockMutate.mock.calls[0][0]).toMatchObject({ action: 'sheet', name: 'a.csv' }));
    });

    it('keeps dirty buffers when the draft changes on the server, warns, and discards on request', () => {
      const view = openDraft();
      edit('tutorial-draft-pitch', 'my edit');
      setDrafts([draft({ contentSeq: 4, pitch: 'theirs', content: { ...draft().content, pitch: 'theirs' } })]);
      view.rerender(
        <CssVarsProvider theme={appTheme}>
          <TutorialDraftsCard apiBase="/api/test-tutorials" owner="core" />
        </CssVarsProvider>
      );
      expect(screen.getByTestId('tutorial-draft-pitch')).toHaveValue('my edit');
      expect(screen.getByTestId('tutorial-draft-changed-warning')).toHaveTextContent(
        'This draft changed since you started editing. Saving will replace that change.'
      );
      fireEvent.click(screen.getByTestId('tutorial-draft-save'));
      expect(mockMutate.mock.calls[0][0]).toMatchObject({ contentSeq: 4, pitch: 'my edit' });
      fireEvent.click(screen.getByTestId('tutorial-draft-discard'));
      expect(screen.getByTestId('tutorial-draft-pitch')).toHaveValue('theirs');
      expect(screen.queryByTestId('tutorial-draft-changed-warning')).not.toBeInTheDocument();
    });

    it('reseeds without a warning when the editor is clean', () => {
      const view = openDraft();
      setDrafts([draft({ contentSeq: 4, content: { ...draft().content, pitch: 'theirs' } })]);
      view.rerender(
        <CssVarsProvider theme={appTheme}>
          <TutorialDraftsCard apiBase="/api/test-tutorials" owner="core" />
        </CssVarsProvider>
      );
      expect(screen.getByTestId('tutorial-draft-pitch')).toHaveValue('theirs');
      expect(screen.queryByTestId('tutorial-draft-changed-warning')).not.toBeInTheDocument();
    });
  });
});
