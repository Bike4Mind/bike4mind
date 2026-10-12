import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

vi.mock('@client/app/hooks/data/projects', () => ({
  useCreateProject: () => ({ mutate: vi.fn(), isPending: false }),
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
});
