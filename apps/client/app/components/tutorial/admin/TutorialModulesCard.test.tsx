import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';

const current = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const mockMutate = vi.fn();
vi.mock('@client/app/hooks/tutorials/useTutorialModules', () => ({
  useTutorialModules: () => current.value,
  useSetTutorialModule: () => ({ mutate: mockMutate, isPending: false }),
  useTutorialAnchorChoices: () => ({ data: { anchors: [], anchorScopes: [], avoids: [] } }),
}));
vi.mock('./TutorialOverrideEditor', () => ({
  default: ({ row, onDirtyChange }: { row: { moduleId: string }; onDirtyChange: (dirty: boolean) => void }) => (
    <div data-testid={`mock-editor-${row.moduleId}`}>
      <button data-testid={`mock-dirty-${row.moduleId}`} onClick={() => onDirtyChange(true)} />
    </div>
  ),
}));

import TutorialModulesCard from './TutorialModulesCard';

const BASE = '/api/test-tutorials';
const appTheme = extendTheme({ ...getThemeConfig() });
const renderCard = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <TutorialModulesCard apiBase={BASE} />
    </CssVarsProvider>
  );

const ROWS = [
  {
    moduleId: 'alpha',
    title: 'Alpha',
    version: 8,
    revision: 0,
    repoEnabled: true,
    enabled: true,
    overridden: false,
    lastChange: null,
  },
  {
    moduleId: 'beta',
    title: 'Beta',
    version: 7,
    revision: 0,
    repoEnabled: true,
    enabled: false,
    overridden: true,
    lastChange: { field: 'enabled', actorId: 'admin-1', reason: 'broken anchor', at: '2026-11-08T12:00:00Z' },
  },
];

const switchOf = (id: string) => screen.getByTestId(`tutorial-module-switch-${id}`) as HTMLInputElement;
const typeReason = (text: string) =>
  fireEvent.change(screen.getByTestId('tutorial-modules-reason'), { target: { value: text } });

describe('TutorialModulesCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    current.value = { data: ROWS, isLoading: false, isError: false };
  });

  it('lists every module with its effective switch, override badge and last reason', () => {
    renderCard();
    expect(screen.getByTestId('tutorial-module-row-alpha')).toBeInTheDocument();
    expect(screen.getByTestId('tutorial-module-row-beta')).toHaveTextContent('overridden');
    expect(screen.getByTestId('tutorial-module-row-beta')).toHaveTextContent('broken anchor');
    expect(switchOf('alpha').checked).toBe(true);
    expect(switchOf('beta').checked).toBe(false);
  });

  it('says so when the host has no tutorials', () => {
    current.value = { data: [], isLoading: false, isError: false };
    renderCard();
    expect(screen.getByTestId('tutorial-modules-empty')).toBeInTheDocument();
  });

  it('holds every switch until a reason is given', () => {
    renderCard();
    expect(switchOf('alpha').disabled).toBe(true);
    typeReason('   ');
    expect(switchOf('alpha').disabled).toBe(true);
    typeReason('copy defect on prod');
    expect(switchOf('alpha').disabled).toBe(false);
  });

  it('saves the module, the new value and the trimmed reason', () => {
    renderCard();
    typeReason('  copy defect on prod ');
    fireEvent.click(switchOf('alpha'));
    expect(mockMutate).toHaveBeenCalledWith(
      { moduleId: 'alpha', enabled: false, reason: 'copy defect on prod' },
      expect.anything()
    );
  });

  it('keeps a module the code holds off switched off', () => {
    current.value = { data: [{ ...ROWS[0], repoEnabled: false, enabled: false }], isLoading: false, isError: false };
    renderCard();
    typeReason('x');
    expect(switchOf('alpha').disabled).toBe(true);
    expect(screen.getByTestId('tutorial-module-row-alpha')).toHaveTextContent('off in code');
  });

  it('opens the live editor for one module at a time', () => {
    renderCard();
    expect(screen.queryByTestId('mock-editor-alpha')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('tutorial-module-edit-alpha'));
    expect(screen.getByTestId('mock-editor-alpha')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('tutorial-module-edit-beta'));
    expect(screen.queryByTestId('mock-editor-alpha')).not.toBeInTheDocument();
    expect(screen.getByTestId('mock-editor-beta')).toBeInTheDocument();
  });

  it('asks before switching or closing over an unsaved draft, and keeps it on cancel', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderCard();
    fireEvent.click(screen.getByTestId('tutorial-module-edit-alpha'));
    fireEvent.click(screen.getByTestId('mock-dirty-alpha'));
    fireEvent.click(screen.getByTestId('tutorial-module-edit-beta'));
    fireEvent.click(screen.getByTestId('tutorial-module-edit-alpha'));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('mock-editor-alpha')).toBeInTheDocument();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByTestId('tutorial-module-edit-beta'));
    expect(screen.getByTestId('mock-editor-beta')).toBeInTheDocument();
    confirm.mockRestore();
  });

  it('does not ask when the draft is clean', () => {
    const confirm = vi.spyOn(window, 'confirm');
    renderCard();
    fireEvent.click(screen.getByTestId('tutorial-module-edit-alpha'));
    fireEvent.click(screen.getByTestId('tutorial-module-edit-alpha'));
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('says so when the read fails', () => {
    current.value = { data: undefined, isLoading: false, isError: true };
    renderCard();
    expect(screen.getByText('Could not read the tutorial modules.')).toBeInTheDocument();
  });
});
