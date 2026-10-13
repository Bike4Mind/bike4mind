import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { IProjectDocument } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({ enforceCredits: true }));

vi.mock('@client/app/hooks/data/settings', () => ({
  useGetSettingsValue: (key: string) => (key === 'enforceCredits' ? h.enforceCredits : undefined),
}));
vi.mock('@client/app/hooks/data/invites', () => ({
  useDeleteInvite: () => ({ mutate: vi.fn(), isPending: false }),
  useGetProjectInvites: () => ({ data: { data: [] } }),
}));
vi.mock('@client/app/hooks/data/projects', () => ({
  useLeaveProject: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@client/app/hooks/data/user', () => ({
  useGetUsers: () => ({ isPending: false, data: { users: [] }, refetch: vi.fn() }),
  useUserRevokeSharing: () => ({ mutate: vi.fn() }),
}));
vi.mock('@client/app/utils/react-query', () => ({
  updateAllQueryData: vi.fn(),
  useSubscribeCollection: vi.fn(),
}));
vi.mock('@client/app/hooks/useConfirmation', () => ({ useConfirmation: () => vi.fn() }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@client/app/components/Session/SearchBar', () => ({ default: () => null }));
vi.mock('./AddMembersModal', () => ({ default: () => null }));
vi.mock('./UserCard', () => ({ default: () => null }));

import ProjectMembersSection, { PROJECT_MEMBERS_BILLING_NOTE } from './Members';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderMembers = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <ProjectMembersSection project={{ id: 'p1', userId: 'owner' } as IProjectDocument} ownerId="owner" />
    </CssVarsProvider>
  );

describe('ProjectMembersSection billing note', () => {
  beforeEach(() => {
    h.enforceCredits = true;
  });

  it('says who pays for answers when credits are enforced', () => {
    renderMembers();
    expect(screen.getByTestId('project-members-billing-note')).toHaveTextContent(PROJECT_MEMBERS_BILLING_NOTE);
  });

  it('stays out of the way when credits are not enforced', () => {
    h.enforceCredits = false;
    renderMembers();
    expect(screen.queryByTestId('project-members-billing-note')).toBeNull();
  });
});
