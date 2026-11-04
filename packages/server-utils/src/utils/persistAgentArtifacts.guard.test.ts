import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  userFindById: vi.fn(),
  findUpdateAccessById: vi.fn(),
  questFindById: vi.fn(),
  artifactFindOne: vi.fn(),
  artifactCount: vi.fn(),
  artifactCreate: vi.fn(),
  contentCreate: vi.fn(),
  versionCreate: vi.fn(),
  getSettingsValue: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: mocks.userFindById },
  sessionRepository: { shareable: { findUpdateAccessById: mocks.findUpdateAccessById } },
  questRepository: { findById: mocks.questFindById },
  artifactRepository: {
    findOne: mocks.artifactFindOne,
    count: mocks.artifactCount,
    create: mocks.artifactCreate,
  },
  artifactContentRepository: { create: mocks.contentCreate },
  artifactVersionRepository: { create: mocks.versionCreate },
  adminSettingsRepository: { getSettingsValue: mocks.getSettingsValue },
}));

import { persistAgentArtifacts } from './persistAgentArtifacts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;

const USER_ID = 'run-user';
const SESSION_ID = 'session-1';
const REPLY = `<artifact identifier="foo" type="application/vnd.ant.react" title="Foo">
export default function Foo() { return <div>hi</div>; }
</artifact>`;

function persist(sourceRefsGuard?: Parameters<typeof persistAgentArtifacts>[0]['sourceRefsGuard']) {
  return persistAgentArtifacts({
    replyText: REPLY,
    questId: 'quest-1',
    questCreatedAtMs: 1700000000000,
    sessionId: SESSION_ID,
    userId: USER_ID,
    executionId: 'exec-1',
    logger,
    sourceRefsGuard,
  });
}

function arrange() {
  mocks.getSettingsValue.mockResolvedValue(true);
  mocks.userFindById.mockResolvedValue({ id: USER_ID });
  mocks.artifactFindOne.mockResolvedValue(null);
  mocks.artifactCount.mockResolvedValue(0);
  mocks.questFindById.mockResolvedValue({ sessionId: SESSION_ID });
  mocks.contentCreate.mockResolvedValue({ _id: 'content-1' });
  mocks.versionCreate.mockResolvedValue({ _id: 'version-1' });
  mocks.artifactCreate.mockResolvedValue({ id: 'created' });
}

afterEach(() => {
  vi.resetAllMocks();
});

describe('persistAgentArtifacts default source-ref guard', () => {
  it('refuses to persist an artifact that references a session the run user cannot update', async () => {
    arrange();
    mocks.findUpdateAccessById.mockResolvedValue(null);

    await persist();

    expect(mocks.userFindById).toHaveBeenCalledWith(USER_ID);
    expect(mocks.findUpdateAccessById).toHaveBeenCalledWith({ id: USER_ID }, SESSION_ID, { includeGlobalWrite: true });
    expect(mocks.contentCreate).not.toHaveBeenCalled();
    expect(mocks.versionCreate).not.toHaveBeenCalled();
    expect(mocks.artifactCreate).not.toHaveBeenCalled();
  });

  it('persists an artifact that references a session the run user can update', async () => {
    arrange();
    mocks.findUpdateAccessById.mockResolvedValue({ id: SESSION_ID });

    await persist();

    expect(mocks.findUpdateAccessById).toHaveBeenCalledWith({ id: USER_ID }, SESSION_ID, { includeGlobalWrite: true });
    expect(mocks.artifactCreate).toHaveBeenCalledTimes(1);
    expect(mocks.artifactCreate).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, sessionId: SESSION_ID, sourceQuestId: 'quest-1' })
    );
  });

  it('writes nothing when the acting user cannot be loaded', async () => {
    arrange();
    mocks.userFindById.mockResolvedValue(null);

    await persist();

    expect(mocks.artifactCreate).not.toHaveBeenCalled();
  });

  it('uses an injected guard instead of the default one', async () => {
    arrange();
    const sourceRefsGuard = vi.fn().mockResolvedValue(undefined);

    await persist(sourceRefsGuard);

    expect(sourceRefsGuard).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ sessionId: SESSION_ID, sourceQuestId: 'quest-1' })
    );
    expect(mocks.findUpdateAccessById).not.toHaveBeenCalled();
    expect(mocks.artifactCreate).toHaveBeenCalledTimes(1);
  });
});
