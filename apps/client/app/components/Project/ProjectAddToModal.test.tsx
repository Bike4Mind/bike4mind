import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const mocks = vi.hoisted(() => ({
  projects: [] as Array<{ id: string; name: string }>,
  searchEnabled: [] as Array<boolean | undefined>,
  createMutate: vi.fn(),
  createMutateAsync: vi.fn(),
  addSessionsMutate: vi.fn(),
  addSessionsMutateAsync: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));

vi.mock('@client/app/hooks/data/projects', () => ({
  useSearchProjects: (_search: string, _filters: unknown, _order: unknown, options?: { enabled?: boolean }) => {
    mocks.searchEnabled.push(options?.enabled);
    return {
      data: options?.enabled ? { pages: [{ data: mocks.projects }] } : undefined,
      isLoading: false,
    };
  },
  useAddFilesToProject: () => ({ mutate: vi.fn() }),
  useAddSessionsToProject: () => ({
    mutate: mocks.addSessionsMutate,
    mutateAsync: mocks.addSessionsMutateAsync,
    isPending: false,
  }),
  useCreateProject: () => ({ mutate: mocks.createMutate, mutateAsync: mocks.createMutateAsync, isPending: false }),
}));

import { ProjectAddToModal } from './ProjectAddToModal';

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('ProjectAddToModal', () => {
  beforeEach(() => {
    mocks.projects = [];
    mocks.searchEnabled = [];
    mocks.createMutate.mockReset();
    mocks.createMutateAsync.mockReset();
    mocks.addSessionsMutate.mockReset();
    mocks.addSessionsMutateAsync.mockReset();
    mocks.toastSuccess.mockReset();
    mocks.toastError.mockReset();
  });

  const createNotebookProject = (setOpen: (open: boolean) => void) => {
    render(<ProjectAddToModal open setOpen={setOpen} dataId="session-1" dataType="session" />, { wrapper: Wrapper });
    expect(screen.getByTestId('project-add-to-modal-empty')).toHaveTextContent('No projects yet');
    fireEvent.change(screen.getByTestId('project-add-to-modal-name-input'), { target: { value: '  Campaign  ' } });
    fireEvent.click(screen.getByTestId('project-add-to-modal-create-btn'));
  };

  it('creates a project, adds the notebook, then reports success once and closes', async () => {
    mocks.createMutateAsync.mockResolvedValue({ id: 'new-project', name: 'Campaign' });
    mocks.addSessionsMutateAsync.mockResolvedValue([]);
    const setOpen = vi.fn();
    createNotebookProject(setOpen);

    await waitFor(() => expect(setOpen).toHaveBeenCalledWith(false));
    expect(mocks.createMutateAsync).toHaveBeenCalledWith({ name: 'Campaign', description: '' });
    expect(mocks.addSessionsMutateAsync).toHaveBeenCalledWith({ projectId: 'new-project', sessionIds: ['session-1'] });
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Project created and notebook added');
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('keeps the modal open and says the project exists when adding the notebook fails', async () => {
    mocks.createMutateAsync.mockResolvedValue({ id: 'new-project', name: 'Campaign' });
    mocks.addSessionsMutateAsync.mockRejectedValue(new Error('boom'));
    const setOpen = vi.fn();
    createNotebookProject(setOpen);

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1));
    expect(mocks.toastError.mock.calls[0][0]).toContain('was created, but the notebook could not be added');
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(setOpen).not.toHaveBeenCalled();
  });

  it('does not try to add the notebook when creating the project fails', async () => {
    mocks.createMutateAsync.mockRejectedValue(new Error('nope'));
    const setOpen = vi.fn();
    createNotebookProject(setOpen);

    await waitFor(() => expect(mocks.createMutateAsync).toHaveBeenCalled());
    expect(mocks.addSessionsMutateAsync).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(setOpen).not.toHaveBeenCalled();
  });

  it('keeps the create button disabled until a name is typed', () => {
    render(<ProjectAddToModal open setOpen={vi.fn()} dataId="file-1" dataType="file" />, { wrapper: Wrapper });

    expect(screen.getByTestId('project-add-to-modal-create-btn')).toBeDisabled();
  });

  it('shows the project picker when the user has projects', () => {
    mocks.projects = [{ id: 'p1', name: 'Existing' }];
    render(<ProjectAddToModal open setOpen={vi.fn()} dataId="session-1" dataType="session" />, { wrapper: Wrapper });

    expect(screen.queryByTestId('project-add-to-modal-empty')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search projects...')).toBeInTheDocument();
  });

  it('loads projects when opened through the render-prop trigger', () => {
    mocks.projects = [{ id: 'p1', name: 'Existing' }];
    render(
      <ProjectAddToModal dataId="file-1" dataType="file">
        {({ onClick }) => (
          <button type="button" data-testid="open-add-to-project" onClick={onClick}>
            open
          </button>
        )}
      </ProjectAddToModal>,
      { wrapper: Wrapper }
    );

    fireEvent.click(screen.getByTestId('open-add-to-project'));
    expect(mocks.searchEnabled.at(-1)).toBe(true);
  });

  it('retries only the add (never a second create) when the project list cache stays empty', async () => {
    mocks.createMutateAsync.mockResolvedValue({ id: 'new-project', name: 'Campaign' });
    mocks.addSessionsMutateAsync.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce([]);
    const setOpen = vi.fn();
    createNotebookProject(setOpen);

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId('project-add-to-modal-empty')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(setOpen).toHaveBeenCalledWith(false));
    expect(mocks.createMutateAsync).toHaveBeenCalledTimes(1);
    expect(mocks.addSessionsMutateAsync).toHaveBeenCalledTimes(2);
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Project created and notebook added');
  });

  it('creates only one project when the form is submitted twice in the same tick', async () => {
    mocks.createMutateAsync.mockResolvedValue({ id: 'new-project', name: 'Campaign' });
    mocks.addSessionsMutateAsync.mockResolvedValue([]);
    const setOpen = vi.fn();
    render(<ProjectAddToModal open setOpen={setOpen} dataId="session-1" dataType="session" />, { wrapper: Wrapper });
    fireEvent.change(screen.getByTestId('project-add-to-modal-name-input'), { target: { value: 'Campaign' } });

    const form = screen.getByTestId('project-add-to-modal-empty');
    fireEvent.submit(form);
    fireEvent.submit(form);

    await waitFor(() => expect(setOpen).toHaveBeenCalledWith(false));
    expect(mocks.createMutateAsync).toHaveBeenCalledTimes(1);
    expect(mocks.addSessionsMutateAsync).toHaveBeenCalledTimes(1);
  });
});
