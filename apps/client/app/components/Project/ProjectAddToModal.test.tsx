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
}));

vi.mock('@client/app/hooks/data/projects', () => ({
  useSearchProjects: (_search: string, _filters: unknown, _order: unknown, options?: { enabled?: boolean }) => {
    mocks.searchEnabled.push(options?.enabled);
    return {
      data: options?.enabled ? { pages: [{ data: mocks.projects }] } : undefined,
      isLoading: false,
    };
  },
  useAddFilesToProject: () => ({ mutate: vi.fn() }),
  useAddSessionsToProject: () => ({ mutate: mocks.addSessionsMutate }),
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
  });

  it('offers to create a project, with the notebook in it, when the user has none', async () => {
    mocks.createMutateAsync.mockResolvedValue({ id: 'new-project' });
    render(<ProjectAddToModal open setOpen={vi.fn()} dataId="session-1" dataType="session" />, { wrapper: Wrapper });

    expect(screen.getByTestId('project-add-to-modal-empty')).toHaveTextContent('No projects yet');
    fireEvent.change(screen.getByTestId('project-add-to-modal-name-input'), { target: { value: '  Campaign  ' } });
    fireEvent.click(screen.getByTestId('project-add-to-modal-create-btn'));

    await waitFor(() =>
      expect(mocks.addSessionsMutate).toHaveBeenCalledWith({ projectId: 'new-project', sessionIds: ['session-1'] })
    );
    expect(mocks.createMutateAsync).toHaveBeenCalledWith({ name: 'Campaign', description: '' });
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
});
