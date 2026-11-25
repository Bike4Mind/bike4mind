// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@bike4mind/observability';

const h = vi.hoisted(() => ({
  findListing: vi.fn(),
  snapshot: vi.fn(),
  findSkill: vi.fn(),
  findFile: vi.fn(),
  createSession: vi.fn(),
  createQuest: vi.fn(),
  findQuest: vi.fn(),
  write: vi.fn(),
  fail: vi.fn(),
  release: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  Quest: { create: h.createQuest },
  questRepository: { findById: h.findQuest },
  sessionRepository: { create: h.createSession },
  skillRepository: { findById: h.findSkill },
  fabFileRepository: { findById: h.findFile },
  failSkillTemplateExampleRun: h.fail,
  adminSettingsRepository: {},
  dataLakeRepository: {},
  organizationRepository: {},
  User: {},
}));
vi.mock('@bike4mind/services/llm', () => ({ QuestStartBodySchema: { parse: (body: unknown) => body } }));
vi.mock('@bike4mind/server-utils/services/operationsModelService', () => ({ OperationsModelService: {} }));
vi.mock('@bike4mind/server-utils/skillMarket/market', () => ({ findListing: h.findListing }));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: vi.fn(),
  getGeneratedImageStorage: vi.fn(),
}));
vi.mock('./template', () => ({
  approvedSnapshotOf: h.snapshot,
  isLive: (listing: { status: string }) => listing.status === 'approved',
  writeTemplateExample: h.write,
}));
vi.mock('./classifySkill', () => ({ getOperationsClassifierLlm: vi.fn() }));
vi.mock('./templateExample', async importOriginal => ({
  ...(await importOriginal<typeof import('./templateExample')>()),
  releaseExampleRun: h.release,
}));
vi.mock('./templateFreeRun', () => ({ renderFreeRunResult: (md: string) => ({ html: `<p>${md}</p>` }) }));

import { runTemplateExample, sampleFileName, type TemplateExampleRunDeps } from './templateExampleRun';
import type { TemplateExampleDispatch } from './templateExample';

const logger = new Logger({ metadata: {} });
const payload = (extra: Partial<TemplateExampleDispatch> = {}): TemplateExampleDispatch => ({
  listingId: 'l1',
  userId: 'author-1',
  runAt: '2026-11-25T12:00:00.000Z',
  prompt: 'Plan the launch',
  versionId: 'v1',
  takesFile: false,
  sampleFile: null,
  cap: { key: 'cap-key', expiresAt: '2026-11-26T00:00:00.000Z' },
  ...extra,
});
const RUN_AT = new Date('2026-11-25T12:00:00.000Z');

const deps = (overrides: Partial<TemplateExampleRunDeps> = {}): TemplateExampleRunDeps => ({
  processQuest: vi.fn(async (_body, _logger, exampleRun) => {
    exampleRun.onStep({ label: 'Searched issues in example-org/app', simulated: true });
    exampleRun.onStep({ label: 'Generated an image', simulated: false });
  }),
  textModel: vi.fn(async () => ({ modelId: 'ops-model', complete: vi.fn(async () => '# Sample notes') })),
  storeSample: vi.fn(async () => 'sample-file-1'),
  mediaInfo: vi.fn(async () => ({ bytes: 1000, mime: 'image/png' })),
  getClassifier: vi.fn(async () => ({ model: 'stub', complete: vi.fn() })),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.findListing.mockResolvedValue({
    id: 'l1',
    status: 'approved',
    currentApprovedVersionId: 'v1',
    authorUserId: 'author-1',
    sourceSkillId: 'skill-1',
  });
  h.snapshot.mockResolvedValue({
    snapshot: { name: 'launch-plan', body: 'Plan it', allowedTools: ['web_search', 'github__search_issues'] },
    versionId: 'v1',
  });
  h.findSkill.mockResolvedValue({ id: 'skill-1', name: 'launch-plan', userId: 'author-1' });
  h.createSession.mockResolvedValue({ id: 'session-1' });
  h.createQuest.mockResolvedValue({ id: 'quest-1' });
  h.findQuest.mockResolvedValue({
    type: 'message',
    reply: 'Here is the plan.\n<artifact identifier="p" type="text/markdown" title="Launch plan"># Steps</artifact>',
    replies: [],
    images: ['generated/one.png'],
  });
  h.write.mockResolvedValue({ status: 'draft' });
  h.fail.mockResolvedValue(true);
  h.release.mockResolvedValue(undefined);
});

describe('runTemplateExample', () => {
  it('runs the skill as the author in a hidden notebook and stores the harvested example', async () => {
    const d = deps();
    await runTemplateExample(payload(), logger, d);

    expect(h.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'author-1', surface: 'skill-template-example' })
    );
    const body = vi.mocked(d.processQuest).mock.calls[0][0];
    expect(body).toMatchObject({
      userId: 'author-1',
      sessionId: 'session-1',
      questId: 'quest-1',
      message: '/launch-plan Plan the launch',
      params: { model: 'ops-model' },
      enableMementos: false,
      enableQuestMaster: false,
      tools: ['web_search'],
      mcpServers: ['github'],
    });
    expect(h.write).toHaveBeenCalledWith(
      'l1',
      { 'example.status': 'running', 'example.runAt': RUN_AT },
      {
        $set: {
          'example.status': 'ready',
          'example.prompt': 'Plan the launch',
          'example.reply': 'Here is the plan.',
          'example.replyTrimmedTo': null,
          'example.artifact': { type: 'code', title: 'Launch plan', html: '<p># Steps</p>' },
          'example.media': { kind: 'image', items: [{ key: 'generated/one.png', mime: 'image/png', bytes: 1000 }] },
          'example.sampleFile': null,
          'example.steps': [
            { label: 'Searched issues in example-org/app', simulated: true },
            { label: 'Generated an image', simulated: false },
          ],
          'example.generatedFromVersionId': 'v1',
        },
        $unset: { 'example.error': 1 },
      },
      // A shown example on a published page is re-scanned in the same write.
      { 'example.enabled': true },
      { getClassifier: expect.any(Function) }
    );
    await h.write.mock.calls[0][4].getClassifier();
    expect(d.getClassifier).toHaveBeenCalledWith(logger, 'author-1');
    expect(h.fail).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
  });

  it('generates a sample file the author owns when the skill takes one', async () => {
    const d = deps();
    await runTemplateExample(payload({ takesFile: true }), logger, d);
    expect(d.storeSample).toHaveBeenCalledWith('author-1', '# Sample notes', sampleFileName('launch-plan'));
    expect(vi.mocked(d.processQuest).mock.calls[0][0]).toMatchObject({
      messageFileIds: ['sample-file-1'],
      fabFileIds: ['sample-file-1'],
    });
    expect(h.write.mock.calls[0][2].$set['example.sampleFile']).toEqual({
      name: 'launch-plan-sample.md',
      mime: 'text/markdown',
      pages: 1,
      source: 'generated',
      fabFileId: 'sample-file-1',
    });
  });

  it("uses the author's uploaded sample while they still own it", async () => {
    h.findFile.mockResolvedValue({ userId: 'author-1', moderationStatus: 'clean' });
    const d = deps();
    const sampleFile = { fabFileId: 'up-1', name: 'brief.pdf', mime: 'application/pdf' };
    await runTemplateExample(payload({ takesFile: true, sampleFile }), logger, d);
    expect(d.storeSample).not.toHaveBeenCalled();
    expect(h.write.mock.calls[0][2].$set['example.sampleFile']).toEqual({ ...sampleFile, source: 'upload' });
  });

  it.each(['pending', 'scanning', 'blocked', undefined])(
    'writes a fresh sample instead of reusing an upload that is %s',
    async moderationStatus => {
      h.findFile.mockResolvedValue({ userId: 'author-1', moderationStatus });
      const d = deps();
      const sampleFile = { fabFileId: 'up-1', name: 'brief.pdf', mime: 'application/pdf' };
      await runTemplateExample(payload({ takesFile: true, sampleFile }), logger, d);
      expect(d.storeSample).toHaveBeenCalled();
      expect(h.write.mock.calls[0][2].$set['example.sampleFile']).toMatchObject({ source: 'generated' });
    }
  );

  it.each([
    ['the listing is no longer live', () => h.findListing.mockResolvedValue({ status: 'withdrawn' })],
    ['the skill is gone', () => h.findSkill.mockResolvedValue(null)],
    ['the quest errored', () => h.findQuest.mockResolvedValue({ type: 'error', reply: 'boom' })],
    ['the reply is empty', () => h.findQuest.mockResolvedValue({ type: 'message', reply: '  ', replies: [] })],
  ])('fails the run and gives it back when %s', async (_name, arrange) => {
    arrange();
    await runTemplateExample(payload(), logger, deps());
    expect(h.write).not.toHaveBeenCalled();
    expect(h.fail).toHaveBeenCalledWith('l1', RUN_AT, expect.any(String));
    expect(h.release).toHaveBeenCalledWith({ key: 'cap-key', expiresAt: '2026-11-26T00:00:00.000Z' });
  });

  it('fails the run when processing throws', async () => {
    await runTemplateExample(
      payload(),
      logger,
      deps({ processQuest: vi.fn(async () => Promise.reject(new Error('provider down'))) })
    );
    expect(h.fail).toHaveBeenCalledWith('l1', RUN_AT, 'provider down');
    expect(h.release).toHaveBeenCalled();
  });
});
