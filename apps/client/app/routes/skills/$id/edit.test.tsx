// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({
  isAdmin: false,
  skill: { id: 's1', name: 'summarize', description: 'd', body: 'b' } as Record<string, unknown>,
}));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn(), useParams: () => ({ id: 's1' }) }));
vi.mock('@client/app/hooks/useDocumentTitle', () => ({ useDocumentTitle: vi.fn() }));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { id: 'u1', isAdmin: h.isAdmin } }),
}));
vi.mock('@client/app/hooks/data/skills', () => ({
  useGetSkill: () => ({ data: h.skill, isLoading: false }),
  useUpdateSkill: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@client/app/components/SkillsManagement/SkillForm', () => ({ SkillForm: () => null }));

import EditSkillPage from './edit';

const appTheme = extendTheme({ ...getThemeConfig() });

const renderPage = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <EditSkillPage />
    </CssVarsProvider>
  );

describe('EditSkillPage global-skill hint', () => {
  beforeEach(() => {
    h.isAdmin = false;
    h.skill = { id: 's1', name: 'summarize', description: 'd', body: 'b' };
  });

  it('tells a non-admin that global skill content changes go through the Skill Market', () => {
    h.skill = { ...h.skill, isGlobalRead: true };
    renderPage();
    expect(screen.getByTestId('skill-edit-global-alert')).toBeInTheDocument();
  });

  it('shows the hint for a skill that is only globally writable', () => {
    h.skill = { ...h.skill, isGlobalWrite: true };
    renderPage();
    expect(screen.getByTestId('skill-edit-global-alert')).toBeInTheDocument();
  });

  it('is hidden from a super-admin', () => {
    h.isAdmin = true;
    h.skill = { ...h.skill, isGlobalRead: true };
    renderPage();
    expect(screen.queryByTestId('skill-edit-global-alert')).toBeNull();
  });

  it('is hidden on a skill that is not global', () => {
    renderPage();
    expect(screen.getByTestId('edit-skill-page')).toBeInTheDocument();
    expect(screen.queryByTestId('skill-edit-global-alert')).toBeNull();
  });
});
