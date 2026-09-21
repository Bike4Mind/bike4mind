import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression guard for the shared-plan export image leak/loss: when a COLLABORATOR (in the plan's
 * `sharedWith`, not its owner) exports the plan, the per-image object-level access check must run
 * against the plan OWNER, not the caller. The owner's uploaded figures are not individually shared
 * with the collaborator, so authorizing them against the caller turned every figure into an "Image
 * unavailable" breadcrumb. This drives the REAL `dispatch`; only the process edges (DB, storage,
 * websocket, zip, LLM summary) are stubbed, and the access stub mimics the real ACL: a file is
 * accessible only to its owner.
 */

// Hoisted so the vi.mock factories (themselves hoisted above module init) can reference these.
const h = vi.hoisted(() => {
  const OWNER_ID = 'owner-1';
  const COLLABORATOR_ID = 'collab-2';
  const OWNER_FILE_ID = 'file-owner';
  const OWNER_IMAGE_URL = 'https://test-bucket.s3.amazonaws.com/uploads/owner-fig.png';
  const OWNER_IMAGE_KEY = 'uploads/owner-fig.png';
  // The quest lives in this session; filterReadableQuests keeps it only if the CALLER can read the
  // session, so the collaborator is user-shared on it. (Session ids must be ObjectId-shaped.) The
  // embedded image is then separately authorized against the OWNER - the behavior under test.
  const SESSION_ID = '507f1f77bcf86cd799439011';
  return {
    OWNER_ID,
    COLLABORATOR_ID,
    OWNER_FILE_ID,
    OWNER_IMAGE_URL,
    OWNER_IMAGE_KEY,
    SESSION_ID,
    findAccessibleById: vi.fn(async (user: { id?: string } | null, fileId: string) =>
      user?.id === OWNER_ID ? { id: fileId } : null
    ),
    findUserById: vi.fn(async (id: string) => ({ id, _id: id })),
    sessionFindById: vi.fn(async (id: string) =>
      id === SESSION_ID ? { _id: SESSION_ID, userId: OWNER_ID, users: [{ userId: COLLABORATOR_ID }] } : null
    ),
    // filterReadableQuests resolves sessions in bulk and keys readability by `session.id`.
    sessionFindAllByIds: vi.fn(async (ids: string[]) =>
      ids
        .filter(id => id === SESSION_ID)
        .map(id => ({ id, _id: id, userId: OWNER_ID, users: [{ userId: COLLABORATOR_ID }] }))
    ),
    runOrgFeedbackSummary: vi.fn(async () => undefined),
    planFindById: vi.fn(),
    questFind: vi.fn(() => ({
      lean: async () => [{ _id: 'q1', sessionId: SESSION_ID, reply: `![fig](${OWNER_IMAGE_URL})`, images: [] }],
    })),
    fabFileFindOne: vi.fn(async ({ filePath }: { filePath: string }) =>
      filePath === OWNER_IMAGE_KEY ? { id: OWNER_FILE_ID, filePath, moderationStatus: 'clean' } : null
    ),
    download: vi.fn(async () => Buffer.from('image-bytes')),
    createZipBuffer: vi.fn(async () => Buffer.from('zip')),
  };
});

// Run the raw handler directly (no SQS logger injection wrapper).
vi.mock('@server/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...args: unknown[]) => unknown) => fn,
}));

const benignStub: ProxyHandler<object> = {
  get(_, key) {
    if (key === 'then') return undefined;
    return `mock-${String(key)}`;
  },
};
vi.mock('sst', () => ({
  Resource: new Proxy({} as Record<string, unknown>, { get: () => new Proxy({}, benignStub) }),
}));

vi.mock('@bike4mind/database', () => ({
  QuestMasterPlan: { findById: h.planFindById },
  Quest: { find: h.questFind },
  FabFile: { findOne: h.fabFileFindOne },
  fabFileRepository: { shareable: { findAccessibleById: h.findAccessibleById } },
  userRepository: { findById: h.findUserById },
  sessionRepository: { findById: h.sessionFindById, findAllByIds: h.sessionFindAllByIds },
  apiKeyRepository: {},
  adminSettingsRepository: {},
}));

// The real parse, not an identity stub: this queue now carries two message shapes and the union
// that tells them apart is what these tests drive.
vi.mock('@bike4mind/utils', () => ({
  secureParameters: (obj: unknown, schema: { parse: (value: unknown) => unknown }) => schema.parse(obj),
  getSettingsByNames: vi.fn(),
}));

// The thinking-tag exports come through real: reply extraction runs on them, and a hand-rolled
// stub here would assert against the stub instead of the rule the chat transcript renders by.
vi.mock('@bike4mind/common', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/common')>('@bike4mind/common');
  return {
    ChatModels: { CLAUDE_4_5_HAIKU_BEDROCK: 'claude-haiku' },
    ORG_FEEDBACK_SUMMARY_JOB_TYPE: 'orgFeedbackSummary',
    isImageServeable: (f: { moderationStatus?: string } | null) => f?.moderationStatus === 'clean',
    THINK_OPEN_TAG: actual.THINK_OPEN_TAG,
    THINK_CLOSE_TAG: actual.THINK_CLOSE_TAG,
    visibleReplyText: actual.visibleReplyText,
  };
});

// No summary model available -> generateSummary short-circuits to null (no LLM call).
vi.mock('@bike4mind/llm-adapters', () => ({
  getAvailableModels: vi.fn(async () => []),
  getLlmByModel: vi.fn(() => null),
}));

vi.mock('@bike4mind/services', () => ({
  apiKeyService: { getEffectiveLLMApiKeys: vi.fn(async () => ({})) },
}));

vi.mock('@bike4mind/observability', () => ({ Logger: class {} }));

vi.mock('@bike4mind/fab-pipeline', () => ({
  S3Storage: class {
    getMetadata = vi.fn().mockRejectedValue(new Error('not found')); // ZIP absent -> proceed
    upload = vi.fn().mockResolvedValue(undefined);
    getSignedUrl = vi.fn().mockResolvedValue('https://download.test/export.zip');
  },
}));

vi.mock('@server/utils/storage', () => ({
  getFilesStorage: () => ({ download: h.download }),
  getGeneratedImageStorage: () => ({ download: h.download }),
}));

vi.mock('@server/websocket/utils', () => ({ sendToClient: vi.fn() }));

vi.mock('@client/app/utils/subQuestStatusPresentation', () => ({ getSubQuestStatusIcon: () => '' }));

vi.mock('./createZipBuffer', () => ({ createZipBuffer: h.createZipBuffer }));

// The summary worker is exercised in its own file; here only the routing matters. The payload
// schema is real because the dispatch's union is built from it at module load.
vi.mock('@server/queueHandlers/orgFeedbackSummary', async () => {
  const { z } = await import('zod');
  return {
    OrgFeedbackSummaryPayload: z.object({
      jobType: z.literal('orgFeedbackSummary'),
      summaryJobId: z.string(),
      organizationId: z.string(),
      startDate: z.string(),
      endDate: z.string(),
      userId: z.string(),
    }),
    runOrgFeedbackSummary: h.runOrgFeedbackSummary,
  };
});

import { dispatch } from './questExport';

const makeLogger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), updateMetadata: vi.fn() });

const runExport = (callerId: string) => {
  h.planFindById.mockResolvedValue({
    userId: h.OWNER_ID,
    sharedWith: [h.COLLABORATOR_ID],
    goal: 'Shared Plan',
    state: 'active',
    quests: [
      {
        title: 'Q',
        description: 'd',
        complexity: 'simple',
        subQuests: [{ title: 'sq', status: 'completed', questId: 'q1' }],
      },
    ],
  });
  const event = {
    Records: [{ body: JSON.stringify({ exportJobId: 'job-1', planId: 'plan-1', userId: callerId }) }],
  };
  return dispatch(event as never, {} as never, makeLogger() as never);
};

describe('questExport image access subject', () => {
  beforeEach(() => vi.clearAllMocks());

  it('authorizes owner-uploaded images against the plan owner, not the collaborator running the export', async () => {
    await runExport(h.COLLABORATOR_ID);

    // The access check ran against the OWNER (fix), so the owner-uploaded figure was retained...
    expect(h.findAccessibleById).toHaveBeenCalledWith(expect.objectContaining({ id: h.OWNER_ID }), h.OWNER_FILE_ID);
    expect(h.download).toHaveBeenCalledWith(h.OWNER_IMAGE_KEY);

    // ...and reached the zip instead of degrading to a breadcrumb.
    expect(h.createZipBuffer).toHaveBeenCalledTimes(1);
    const [markdown, imageBuffers] = h.createZipBuffer.mock.calls[0] as unknown as [string, unknown[]];
    expect(imageBuffers).toHaveLength(1);
    expect(markdown).not.toContain('Image unavailable');
  });
});

/**
 * Regression guard for the owner-arm IDOR: filterReadableQuests applies the plan-owner readability
 * arm ONLY when the caller IS the owner. A plan sharee can write subQuest.questId, so passing the
 * owner arm for a sharee would let them inject the id of a quest in a session only the owner can read
 * and exfiltrate the owner's private content. The owner arm must still recover the owner's own quests
 * (e.g. sessions they soft-deleted) when the owner exports their own plan.
 *
 * This drives the REAL dispatch and asserts on the markdown handed to createZipBuffer: a dropped
 * quest degrades to "_Response content unavailable._"; a kept quest emits its reply.
 */
describe('questExport owner-arm readability', () => {
  const PRIVATE_SESSION_ID = '507f191e810c19729de860ea';
  const SECRET_REPLY = 'OWNER-PRIVATE-QUEST-CONTENT';
  const SHAREE_ID = 'sharee-9';

  beforeEach(() => {
    vi.clearAllMocks();
    // Owner-only session: owner-owned, shared with no one. The mock filters by the ids actually
    // requested (not a hardcoded echo) so a .lean() regression that mistyped sessionId would surface.
    h.sessionFindAllByIds.mockImplementation(async (ids: string[]) =>
      ids.filter(id => id === PRIVATE_SESSION_ID).map(id => ({ id, _id: id, userId: h.OWNER_ID, users: [] }))
    );
    h.questFind.mockReturnValue({
      lean: async () => [{ _id: 'q-secret', sessionId: PRIVATE_SESSION_ID, reply: SECRET_REPLY, images: [] }],
    });
  });

  const runExportOf = (callerId: string) => {
    h.planFindById.mockResolvedValue({
      userId: h.OWNER_ID,
      sharedWith: [SHAREE_ID],
      goal: 'Owner Plan',
      state: 'active',
      quests: [
        {
          title: 'Q',
          description: 'd',
          complexity: 'simple',
          subQuests: [{ title: 'sq', status: 'completed', questId: 'q-secret' }],
        },
      ],
    });
    const event = {
      Records: [{ body: JSON.stringify({ exportJobId: 'job-2', planId: 'plan-2', userId: callerId }) }],
    };
    return dispatch(event as never, {} as never, makeLogger() as never);
  };

  const exportedMarkdown = () => {
    expect(h.createZipBuffer).toHaveBeenCalledTimes(1);
    const [markdown] = h.createZipBuffer.mock.calls[0] as unknown as [string];
    return markdown;
  };

  it('drops an owner-only quest a sharee injected into subQuest.questId', async () => {
    await runExportOf(SHAREE_ID);
    const markdown = exportedMarkdown();
    expect(markdown).not.toContain(SECRET_REPLY);
    expect(markdown).toContain('_Response content unavailable._');
  });

  it('keeps that quest when the owner exports their own plan', async () => {
    await runExportOf(h.OWNER_ID);
    const markdown = exportedMarkdown();
    expect(markdown).toContain(SECRET_REPLY);
    expect(markdown).not.toContain('_Response content unavailable._');
  });
});

/**
 * Regression guard for the empty sub-task bodies: the chat pipeline streams the assistant answer
 * into `replies[]` and leaves the scalar `reply` null on a successful turn, so reading `reply`
 * alone emitted a heading followed by nothing for every completed task. Extraction must match the
 * chat transcript - prefer the array, keep hidden reasoning out, and still honour a legacy
 * `reply`-only document.
 */
describe('questExport reply extraction', () => {
  const REPLY_SESSION_ID = '507f191e810c19729de860eb';

  beforeEach(() => {
    vi.clearAllMocks();
    h.sessionFindAllByIds.mockImplementation(async (ids: string[]) =>
      ids.filter(id => id === REPLY_SESSION_ID).map(id => ({ id, _id: id, userId: h.OWNER_ID, users: [] }))
    );
  });

  const exportQuest = async (quest: Record<string, unknown>) => {
    h.questFind.mockReturnValue({
      lean: async () => [{ _id: 'q-reply', sessionId: REPLY_SESSION_ID, images: [], ...quest }],
    });
    h.planFindById.mockResolvedValue({
      userId: h.OWNER_ID,
      sharedWith: [],
      goal: 'Reply Plan',
      state: 'active',
      quests: [
        {
          title: 'Q',
          description: 'd',
          complexity: 'simple',
          subQuests: [{ title: 'sq', status: 'completed', questId: 'q-reply' }],
        },
      ],
    });
    const event = {
      Records: [{ body: JSON.stringify({ exportJobId: 'job-3', planId: 'plan-3', userId: h.OWNER_ID }) }],
    };
    await dispatch(event as never, {} as never, makeLogger() as never);
    expect(h.createZipBuffer).toHaveBeenCalledTimes(1);
    const [markdown] = h.createZipBuffer.mock.calls[0] as unknown as [string];
    return markdown;
  };

  it('exports the streamed answer from replies[] when the scalar reply is null', async () => {
    const markdown = await exportQuest({ reply: null, replies: ['The streamed answer.'] });
    expect(markdown).toContain('The streamed answer.');
  });

  it('exports the answer slot of a multi-slot replies array without the hidden reasoning', async () => {
    const markdown = await exportQuest({
      reply: null,
      replies: ['<think>weighing the options</think>', 'The answer is 42.'],
    });
    expect(markdown).toContain('The answer is 42.');
    expect(markdown).not.toContain('weighing the options');
  });

  it('prefers replies[] over the stale prefix the rapid-reply handoff leaves in the scalar', async () => {
    const markdown = await exportQuest({
      reply: 'Rapid prefix. ',
      replies: ['Rapid prefix. The rest of the streamed answer.'],
    });
    expect(markdown).toContain('Rapid prefix. The rest of the streamed answer.');
    expect(markdown.match(/Rapid prefix\./g)).toHaveLength(1);
  });

  it('still exports a legacy quest that only populated the scalar reply', async () => {
    const markdown = await exportQuest({ reply: 'Legacy flat reply.', replies: [] });
    expect(markdown).toContain('Legacy flat reply.');
  });

  it('marks a turn with no visible text instead of emitting a blank section', async () => {
    const markdown = await exportQuest({ reply: null, replies: ['<think>still thinking</think>'] });
    expect(markdown).toContain('_No response content._');
    expect(markdown).not.toContain('still thinking');
  });
});

/**
 * This queue carries the org feedback summary too - see `orgFeedbackSummary.ts` for why it rides
 * here rather than on a queue of its own. Both arms are asserted because the untagged shape is
 * what every message already in flight looks like.
 */
describe('questExport queue multiplex', () => {
  beforeEach(() => vi.clearAllMocks());

  it('routes a tagged summary message to the summary worker', async () => {
    const event = {
      Records: [
        {
          body: JSON.stringify({
            jobType: 'orgFeedbackSummary',
            summaryJobId: 'sum-1',
            organizationId: 'org-1',
            startDate: '2026-08-01T00:00:00.000Z',
            endDate: '2026-08-31T00:00:00.000Z',
            userId: 'requester-1',
          }),
        },
      ],
    };

    await dispatch(event as never, {} as never, makeLogger() as never);

    expect(h.runOrgFeedbackSummary).toHaveBeenCalledWith(
      expect.objectContaining({ summaryJobId: 'sum-1' }),
      expect.anything()
    );
    expect(h.planFindById).not.toHaveBeenCalled();
  });

  it('still exports an untagged legacy message', async () => {
    await runExport(h.OWNER_ID);

    expect(h.runOrgFeedbackSummary).not.toHaveBeenCalled();
    expect(h.createZipBuffer).toHaveBeenCalledTimes(1);
  });
});
