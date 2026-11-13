import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';
import type { TutorialModuleOverrideRow } from './adminTypes';

const mockMutate = vi.fn();
const mockRefetch = vi.fn();
vi.mock('@client/app/hooks/tutorials/useTutorialModules', () => {
  class TutorialEditRefused extends Error {
    constructor(
      message: string,
      readonly rules: { stepId?: string; rule: string; message: string }[],
      readonly conflict = false
    ) {
      super(message);
    }
  }
  return {
    TutorialEditRefused,
    useSaveTutorialEdits: () => ({ mutate: mockMutate, isPending: false }),
    useTutorialModules: () => ({ refetch: mockRefetch, isFetching: false }),
  };
});

import { TutorialEditRefused } from '@client/app/hooks/tutorials/useTutorialModules';
import TutorialOverrideEditor from './TutorialOverrideEditor';

const BASE = '/api/test-tutorials';
const appTheme = extendTheme({ ...getThemeConfig() });
const CHOICES = { anchors: ['attach-files-btn', 'send-message-btn'], anchorScopes: [], avoids: [] };

const ROW: TutorialModuleOverrideRow = {
  moduleId: 'alpha',
  title: 'Alpha',
  version: 8,
  revision: 0,
  contentSeq: 4,
  repoEnabled: true,
  enabled: true,
  overridden: false,
  lastChange: null,
  lastFieldsChange: null,
  repo: {
    steps: [
      { id: 'opening', type: 'prompt', title: 'Open', body: 'Send the brief.', turn: 0, prompt: 'Brief' },
      { id: 'ask', type: 'prompt', title: 'Ask', body: 'Ask a follow-up.', turn: 1, prompt: 'Follow up' },
      { id: 'pinned', type: 'point', title: 'Pinned title', body: 'Point here.', anchor: 'send-message-btn' },
    ],
    turns: [
      { turn: 0, prompt: 'Brief', reply: 'First reply.' },
      { turn: 1, prompt: 'Follow up', reply: 'Second reply.' },
    ],
  },
  // `opening` lists its prompt so only the turn-0 guard keeps it read-only.
  editable: { opening: ['title', 'body', 'prompt'], ask: ['title', 'body', 'prompt'], pinned: ['body'] },
  fields: [],
  report: { states: [], rejected: [], structuralDigest: 'd' },
};

const renderEditor = (row: TutorialModuleOverrideRow = ROW, onDirtyChange?: (dirty: boolean) => void) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <TutorialOverrideEditor apiBase={BASE} owner="core" row={row} choices={CHOICES} onDirtyChange={onDirtyChange} />
    </CssVarsProvider>
  );

const rerenderRow = (view: ReturnType<typeof renderEditor>, row: TutorialModuleOverrideRow) =>
  view.rerender(
    <CssVarsProvider theme={appTheme}>
      <TutorialOverrideEditor apiBase={BASE} owner="core" row={row} choices={CHOICES} />
    </CssVarsProvider>
  );

const field = (stepId: string, name: string) =>
  screen.getByTestId(`tutorial-override-field-${stepId}-${name}`) as HTMLTextAreaElement;
const type = (el: Element, value: string) => fireEvent.change(el, { target: { value } });
const save = () => screen.getByTestId('tutorial-override-save') as HTMLButtonElement;

describe('TutorialOverrideEditor', () => {
  beforeEach(() => {
    mockMutate.mockReset();
    mockRefetch.mockReset();
  });

  it('edits only the listed fields and keeps the rest read-only', () => {
    renderEditor();
    fireEvent.click(screen.getByTestId('tutorial-override-edit-pinned'));
    expect(field('pinned', 'body')).toBeInTheDocument();
    expect(screen.queryByTestId('tutorial-override-field-pinned-title')).not.toBeInTheDocument();
    expect(screen.getByTestId('tutorial-override-step-pinned')).toHaveTextContent('title (edit in code)');
    expect(screen.getByTestId('tutorial-override-anchor-pinned')).toBeInTheDocument();
  });

  it('flags a step whose type no renderer is registered for, and only that one', () => {
    const row = {
      ...ROW,
      repo: { ...ROW.repo, steps: [...ROW.repo.steps, { id: 'odd', type: 'hostOnly', title: 'Odd', body: 'Odd.' }] },
    };
    renderEditor(row);
    expect(screen.getByTestId('tutorial-override-no-renderer-odd')).toBeInTheDocument();
    expect(screen.queryByTestId('tutorial-override-no-renderer-pinned')).not.toBeInTheDocument();
  });

  it('keeps turn 0 prompt read-only while its reply stays editable', () => {
    renderEditor();
    fireEvent.click(screen.getByTestId('tutorial-override-edit-opening'));
    expect(screen.queryByTestId('tutorial-override-field-opening-prompt')).not.toBeInTheDocument();
    expect(field('opening', 'reply').value).toBe('First reply.');
    fireEvent.click(screen.getByTestId('tutorial-override-edit-ask'));
    expect(field('ask', 'prompt').value).toBe('Follow up');
  });

  it('holds Save until something changed and a reason is given, then sends the units', () => {
    renderEditor();
    expect(save().disabled).toBe(true);
    fireEvent.click(screen.getByTestId('tutorial-override-edit-opening'));
    type(field('opening', 'body'), 'Send the whole brief.');
    expect(screen.getByTestId('tutorial-override-diff')).toHaveTextContent('copy:opening:body');
    expect(save().disabled).toBe(true);
    type(screen.getByTestId('tutorial-override-reason'), '  typo on prod ');
    expect(save().disabled).toBe(false);
    fireEvent.click(save());
    expect(mockMutate).toHaveBeenCalledWith(
      {
        moduleId: 'alpha',
        reason: 'typo on prod',
        expectedContentSeq: 4,
        fields: [
          {
            kind: 'copy',
            stepId: 'opening',
            field: 'body',
            value: 'Send the whole brief.',
            repoValue: 'Send the brief.',
          },
        ],
      },
      expect.anything()
    );
  });

  it('moves a step and resets one step without touching the order', () => {
    renderEditor();
    fireEvent.click(screen.getByTestId('tutorial-override-move-down-opening'));
    const order = screen.getAllByTestId(/^tutorial-override-step-/).map(el => el.dataset.testid);
    expect(order).toEqual([
      'tutorial-override-step-ask',
      'tutorial-override-step-opening',
      'tutorial-override-step-pinned',
    ]);
    expect((screen.getByTestId('tutorial-override-move-up-ask') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('tutorial-override-edit-opening'));
    type(field('opening', 'title'), 'Opened');
    fireEvent.click(screen.getByTestId('tutorial-override-reset-step-opening'));
    const diff = screen.getByTestId('tutorial-override-diff');
    expect(diff).toHaveTextContent('order');
    expect(diff).not.toHaveTextContent('copy:opening:title');
  });

  it('resets the whole module with an empty field set', () => {
    const fields = [{ kind: 'reply' as const, turn: 1, value: 'Better.', repoValue: 'Second reply.' }];
    renderEditor({
      ...ROW,
      fields,
      overridden: true,
      report: { ...ROW.report, states: [{ key: 'turn:1', state: 'live' }] },
    });
    expect(screen.getByTestId('tutorial-override-state-turn:1')).toHaveTextContent('live');
    type(screen.getByTestId('tutorial-override-reason'), 'back to repo');
    fireEvent.click(screen.getByTestId('tutorial-override-reset-module'));
    expect(mockMutate).toHaveBeenCalledWith(
      { moduleId: 'alpha', fields: [], reason: 'back to repo', expectedContentSeq: 4 },
      expect.anything()
    );
  });

  it('shows the rules a refused save broke, and a rejected override', () => {
    mockMutate.mockImplementation((_input, options) =>
      options.onError(
        new TutorialEditRefused('The edit breaks a rule', [{ stepId: 'ask', rule: 'ascii', message: 'Use ASCII' }])
      )
    );
    renderEditor({
      ...ROW,
      report: { ...ROW.report, rejected: [{ rule: 'override-locked', message: 'Pinned' }] },
    });
    expect(screen.getByTestId('tutorial-override-rejected-alpha')).toHaveTextContent('override-locked');
    fireEvent.click(screen.getByTestId('tutorial-override-edit-ask'));
    type(field('ask', 'title'), 'Ask \u2014 now');
    type(screen.getByTestId('tutorial-override-reason'), 'x');
    fireEvent.click(save());
    expect(screen.getByTestId('tutorial-override-errors')).toHaveTextContent('ask: Use ASCII (ascii)');
    expect(screen.getByTestId('tutorial-override-step-ask')).toHaveTextContent('Use ASCII');
  });

  const editOpening = (body: string) => {
    if (!screen.queryByTestId('tutorial-override-field-opening-body')) {
      fireEvent.click(screen.getByTestId('tutorial-override-edit-opening'));
    }
    type(field('opening', 'body'), body);
    type(screen.getByTestId('tutorial-override-reason'), 'fix');
  };
  const sentSeq = (call: number) => mockMutate.mock.calls[call][0].expectedContentSeq;

  it('checks a save against the sequence the draft began from, not the refetched row', () => {
    const view = renderEditor();
    editOpening('Mine.');
    const others = [{ kind: 'reply' as const, turn: 1, value: 'Theirs.', repoValue: 'Second reply.' }];
    view.rerender(
      <CssVarsProvider theme={appTheme}>
        <TutorialOverrideEditor
          apiBase={BASE}
          owner="core"
          row={{ ...ROW, contentSeq: 5, fields: others }}
          choices={CHOICES}
        />
      </CssVarsProvider>
    );
    fireEvent.click(save());
    expect(sentSeq(0)).toBe(4);
  });

  it('follows another admin save while untouched, staying clean and checking against the new sequence', () => {
    const onDirtyChange = vi.fn();
    const view = renderEditor(ROW, onDirtyChange);
    const others = [{ kind: 'reply' as const, turn: 1, value: 'Theirs.', repoValue: 'Second reply.' }];
    view.rerender(
      <CssVarsProvider theme={appTheme}>
        <TutorialOverrideEditor
          apiBase={BASE}
          owner="core"
          row={{ ...ROW, contentSeq: 5, fields: others }}
          choices={CHOICES}
          onDirtyChange={onDirtyChange}
        />
      </CssVarsProvider>
    );
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    editOpening('Mine.');
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(save());
    expect(sentSeq(0)).toBe(5);
  });

  it('rebases an untouched no-row editor after a switch creates sequence zero', () => {
    const view = renderEditor({ ...ROW, contentSeq: null });
    rerenderRow(view, { ...ROW, contentSeq: 0, enabled: false });
    expect(save().disabled).toBe(true);
    editOpening('First edit.');
    fireEvent.click(save());
    expect(sentSeq(0)).toBe(0);
  });

  it('keeps a touched no-row draft after a switch creates sequence zero', () => {
    const view = renderEditor({ ...ROW, contentSeq: null });
    editOpening('First edit.');
    rerenderRow(view, { ...ROW, contentSeq: 0, enabled: false });
    expect(field('opening', 'body').value).toBe('First edit.');
    fireEvent.click(save());
    expect(sentSeq(0)).toBeNull();
  });

  it('keeps a touched draft and its original sequence when the row moves under it', () => {
    const onDirtyChange = vi.fn();
    const view = renderEditor(ROW, onDirtyChange);
    editOpening('Mine.');
    const others = [{ kind: 'reply' as const, turn: 1, value: 'Theirs.', repoValue: 'Second reply.' }];
    view.rerender(
      <CssVarsProvider theme={appTheme}>
        <TutorialOverrideEditor
          apiBase={BASE}
          owner="core"
          row={{ ...ROW, contentSeq: 5, fields: others }}
          choices={CHOICES}
          onDirtyChange={onDirtyChange}
        />
      </CssVarsProvider>
    );
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    expect(field('opening', 'body').value).toBe('Mine.');
    fireEvent.click(save());
    expect(sentSeq(0)).toBe(4);
  });

  it('moves its sequence on after its own save, so the next save is not a conflict', () => {
    mockMutate.mockImplementationOnce((_input, options) =>
      options.onSuccess({ modules: [{ ...ROW, contentSeq: 5, fields: [] }], choices: CHOICES })
    );
    const view = renderEditor();
    editOpening('First.');
    fireEvent.click(save());
    // The saved row reaches the editor through the query cache, as it does in the app.
    rerenderRow(view, { ...ROW, contentSeq: 5, fields: [] });
    editOpening('Second.');
    fireEvent.click(save());
    expect(sentSeq(1)).toBe(5);
  });

  it('offers a reload after a conflict, which takes the stored edits and their sequence', async () => {
    const theirs = [{ kind: 'reply' as const, turn: 1, value: 'Theirs.', repoValue: 'Second reply.' }];
    mockRefetch.mockResolvedValue({ data: [{ ...ROW, contentSeq: 6, fields: theirs }] });
    mockMutate.mockImplementationOnce((_input, options) =>
      options.onError(new TutorialEditRefused('The module changed', [], true))
    );
    const view = renderEditor();
    editOpening('Mine.');
    fireEvent.click(save());
    await act(async () => fireEvent.click(screen.getByTestId('tutorial-override-reload')));
    rerenderRow(view, { ...ROW, contentSeq: 6, fields: theirs });
    expect(screen.queryByTestId('tutorial-override-errors')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('tutorial-override-edit-ask'));
    expect(field('ask', 'reply').value).toBe('Theirs.');
    expect(field('opening', 'body').value).toBe('Send the brief.');
  });

  it('shows no reload for a rule refusal', () => {
    mockMutate.mockImplementationOnce((_input, options) => options.onError(new TutorialEditRefused('Broken', [])));
    renderEditor();
    editOpening('Mine.');
    fireEvent.click(save());
    expect(screen.queryByTestId('tutorial-override-reload')).not.toBeInTheDocument();
  });

  it('marks a stale stored order above the steps', () => {
    renderEditor({
      ...ROW,
      fields: [{ kind: 'order', value: ['ask', 'opening', 'pinned'], repoValue: ['opening', 'pinned', 'ask'] }],
      report: { ...ROW.report, states: [{ key: 'order', state: 'stale' }] },
    });
    expect(screen.getByTestId('tutorial-override-state-order')).toHaveTextContent(/stale/i);
  });

  it('exports only live units, with the latest edit to the fields, as a downloaded bundle', async () => {
    const live = { kind: 'reply' as const, turn: 1, value: 'Better.', repoValue: 'Second reply.' };
    const stale = { kind: 'copy' as const, stepId: 'ask', field: 'title' as const, value: 'Asked', repoValue: 'Old' };
    const exportButton = () => screen.getByTestId('tutorial-override-export') as HTMLButtonElement;

    const view = renderEditor({
      ...ROW,
      fields: [stale],
      report: { ...ROW.report, states: [{ key: 'copy:ask:title', state: 'stale' }] },
    });
    expect(exportButton().disabled).toBe(true);
    view.unmount();

    const blobs: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => (blobs.push(blob), 'blob:bundle'));
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const lastFieldsChange = { actorId: 'admin-1', reason: 'typo on prod', at: '2026-11-09T00:00:00.000Z' };
    // A switch toggle after the edit is the module's latest change, but did not author the units.
    const lastChange = { field: 'enabled', actorId: 'admin-9', reason: 'paused', at: '2026-11-09T01:00:00.000Z' };
    renderEditor({
      ...ROW,
      revision: 2,
      fields: [live, stale],
      lastChange,
      lastFieldsChange,
      report: {
        ...ROW.report,
        states: [
          { key: 'turn:1', state: 'live' },
          { key: 'copy:ask:title', state: 'stale' },
        ],
      },
    });
    expect(exportButton().disabled).toBe(false);
    fireEvent.click(exportButton());
    expect(click).toHaveBeenCalled();
    const bundle = JSON.parse(await blobs[0].text());
    expect(bundle).toMatchObject({
      format: 'tutorial-overrides/1',
      owner: 'core',
      moduleId: 'alpha',
      version: 8,
      revision: 2,
      units: [live],
      changes: [{ author: 'admin-1', reason: 'typo on prod', at: lastFieldsChange.at }],
    });
    click.mockRestore();
  });
});
