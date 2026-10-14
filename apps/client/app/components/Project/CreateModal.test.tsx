import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const project = vi.hoisted(() => ({ createProject: vi.fn(), navigate: vi.fn(), fail: false }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => project.navigate }));
// Settles synchronously; succeeds (calling onSuccess, as the real hook does once the request resolves) unless project.fail.
vi.mock('@client/app/hooks/data/projects', () => ({
  useCreateProject: ({ onSuccess }: { onSuccess: (p: { id: string }) => void }) => ({
    mutate: (input: unknown) => {
      project.createProject(input);
      if (!project.fail) onSuccess({ id: 'proj-1' });
    },
    isPending: false,
  }),
}));
vi.mock('./AddSessionsModal', () => ({ default: () => null }));
vi.mock('./AddFilesModal', () => ({ default: () => null }));

import ProjectCreateModal from './CreateModal';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const openDialog = () => {
  render(
    <TestWrapper>
      <ProjectCreateModal />
    </TestWrapper>
  );
  fireEvent.click(screen.getByTestId('new-project-btn'));
};

describe('ProjectCreateModal focus and naming', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    project.fail = false;
  });

  it('is a dialog named by its heading', () => {
    openDialog();
    expect(screen.getByRole('dialog', { name: 'Create Project' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Create Project' })).toBeInTheDocument();
  });

  it('puts focus in the project name field on open', async () => {
    openDialog();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('name-input').querySelector('input')));
  });

  it('returns focus to the opener when it closes, even if the opener never held focus', async () => {
    openDialog();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(screen.getByTestId('new-project-btn'));
  });

  const expectClosedWithFocusOnOpener = async () => {
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(screen.getByTestId('new-project-btn'));
  };

  it('returns focus to the opener when Cancel is pressed', async () => {
    openDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await expectClosedWithFocusOnOpener();
  });

  it('returns focus to the opener when the backdrop is clicked', async () => {
    openDialog();
    const backdrop = document.querySelector<HTMLElement>('.create-project-modal [aria-hidden="true"]');
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop as HTMLElement);
    await expectClosedWithFocusOnOpener();
  });

  it('opens the new project and leaves focus to the new page after a successful submit', async () => {
    openDialog();
    fireEvent.change(within(screen.getByTestId('name-input')).getByRole('textbox'), { target: { value: 'Atlas' } });
    fireEvent.click(screen.getByTestId('create-project-submit-btn'));
    await waitFor(() => expect(project.createProject).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(project.navigate).toHaveBeenCalledWith({ to: '/projects/proj-1' });
    expect(document.activeElement).not.toBe(screen.getByTestId('new-project-btn'));
  });

  it('stays open and does not navigate when create fails', async () => {
    project.fail = true;
    openDialog();
    fireEvent.change(within(screen.getByTestId('name-input')).getByRole('textbox'), { target: { value: 'Atlas' } });
    fireEvent.click(screen.getByTestId('create-project-submit-btn'));
    await waitFor(() => expect(project.createProject).toHaveBeenCalled());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(project.navigate).not.toHaveBeenCalled();
  });
});
