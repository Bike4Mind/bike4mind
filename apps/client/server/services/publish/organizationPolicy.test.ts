import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  artifact: vi.fn(),
  session: vi.fn(),
  project: vi.fn(),
  sessionProjects: vi.fn(),
  file: vi.fn(),
  publicLink: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({
  artifactRepository: { findOne: mocks.artifact },
  sessionRepository: { findById: mocks.session },
  projectRepository: { findById: mocks.project, findAllBySessionId: mocks.sessionProjects },
  fabFileRepository: { findById: mocks.file },
  assertOrganizationPublicLink: mocks.publicLink,
}));
import { assertPublicationPublicLink, publicationOrganizationIds } from './organizationPolicy';
beforeEach(() => {
  vi.resetAllMocks();
  for (const mock of [mocks.artifact, mocks.session, mocks.project, mocks.file]) mock.mockResolvedValue(null);
  mocks.sessionProjects.mockResolvedValue([]);
  mocks.publicLink.mockResolvedValue(undefined);
});
describe('publication organization policy', () => {
  it('uses the source binding even when publishing into personal scope', async () => {
    mocks.artifact.mockResolvedValue({ organizationId: 'org', sessionId: 'session' });
    mocks.session.mockResolvedValue({ organizationId: 'org' });
    mocks.publicLink.mockRejectedValue(new Error('Your organization does not allow public links for this content.'));
    await expect(
      assertPublicationPublicLink({ tier: 'user', scopeId: 'owner', source: { artifactId: 'artifact' } })
    ).rejects.toThrow('does not allow public links');
    expect(mocks.publicLink).toHaveBeenCalledWith('org');
  });
  it('checks both target and source organizations', async () => {
    mocks.session.mockResolvedValue({ organizationId: 'source-org' });
    expect(
      await publicationOrganizationIds({
        tier: 'organization',
        scopeId: 'target-org',
        source: { sessionId: 'session' },
      })
    ).toEqual(['target-org', 'source-org']);
  });
  it('checks a session against the org of a project it was later added to', async () => {
    mocks.session.mockResolvedValue({});
    mocks.sessionProjects.mockResolvedValue([{ organizationId: 'project-org' }, {}]);
    expect(
      await publicationOrganizationIds({ tier: 'user', scopeId: 'owner', source: { sessionId: 'session' } })
    ).toEqual(['project-org']);
    expect(mocks.sessionProjects).toHaveBeenCalledWith('session');
  });
  it('checks every project organization reached through an artifact session', async () => {
    mocks.artifact.mockResolvedValue({ sessionId: 'nested-session' });
    mocks.session.mockResolvedValue({});
    mocks.sessionProjects.mockResolvedValue([{ organizationId: 'first-org' }, { organizationId: 'blocked-org' }]);
    mocks.publicLink.mockImplementation(async (id: string) => {
      if (id === 'blocked-org') throw new Error('public links blocked');
    });
    await expect(
      assertPublicationPublicLink({
        tier: 'user',
        scopeId: 'owner',
        source: { artifactId: 'artifact' },
      })
    ).rejects.toThrow('public links blocked');
    expect(mocks.sessionProjects).toHaveBeenCalledWith('nested-session');
    expect(mocks.publicLink.mock.calls.map(call => call[0])).toEqual(['first-org', 'blocked-org']);
  });
  it('finds a project org binding and leaves unbound legacy content personal', async () => {
    mocks.project.mockResolvedValueOnce({ organizationId: 'org' });
    expect(await publicationOrganizationIds({ tier: 'project', scopeId: 'project' })).toEqual(['org']);
    expect(
      await publicationOrganizationIds({ tier: 'user', scopeId: 'owner', source: { sessionId: 'legacy' } })
    ).toEqual([]);
  });
});
