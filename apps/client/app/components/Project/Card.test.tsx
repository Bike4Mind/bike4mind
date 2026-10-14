import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IProjectDocument } from '@bike4mind/common';
import ProjectCard from './Card';

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: { id: 'user_1' } }) }));
vi.mock('@client/app/hooks/data/user', () => ({ useGetUser: () => ({ data: { name: 'Owner' } }) }));
vi.mock('@client/app/hooks/data/projects', () => ({
  useDeleteProject: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@client/app/hooks/useConfirmation', () => ({ useConfirmation: () => vi.fn() }));
vi.mock('./EditModal', () => ({ default: () => null }));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const project = (name: string) =>
  ({
    id: `p_${name}`,
    name,
    description: 'd',
    userId: 'user_1',
    updatedAt: new Date(),
    sessionIds: [],
    fileIds: [],
    users: [],
  }) as unknown as IProjectDocument;

describe('ProjectCard title', () => {
  it('clamps to two lines instead of one, and exposes the full name as a title attribute', () => {
    render(<ProjectCard project={project('Riverbend Grants Q4')} />, { wrapper: TestWrapper });

    const name = screen.getByTestId('project-card-name');
    expect(name).toHaveTextContent('Riverbend Grants Q4');
    expect(name).toHaveAttribute('title', 'Riverbend Grants Q4');
    const style = getComputedStyle(name);
    expect(style.whiteSpace).not.toBe('nowrap');
    expect(style.webkitLineClamp || style.getPropertyValue('-webkit-line-clamp')).toBe('2');
  });
});
