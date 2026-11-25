// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@bike4mind/observability';

const h = vi.hoisted(() => ({
  findListing: vi.fn(),
  snapshot: vi.fn(),
  findTemplate: vi.fn(),
  settle: vi.fn(),
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
  questRepository: { findById: h.findQuest, settleIfUnfinished: h.settle },
  sessionRepository: { create: h.createSession },
  SkillListingTemplate: { findOne: (query: unknown) => ({ lean: () => h.findTemplate(query) }) },
  fabFileRepository: { findById: h.findFile },
  fabFileChunkRepository: {},
  userRepository: {},
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
vi.mock('@bike4mind/services/llm/imageModerationGate', () => ({ moderateImageOrThrow: vi.fn() }));
vi.mock('@bike4mind/server-utils/moderation/imageModerationIncidents', () => ({ imageModerationIncidents: {} }));
vi.mock('./classifySkill', () => ({ getOperationsClassifierLlm: vi.fn() }));
vi.mock('./templateExample', async importOriginal => ({
  ...(await importOriginal<typeof import('./templateExample')>()),
  releaseExampleRun: h.release,
}));
vi.mock('./templateFreeRun', () => ({ renderFreeRunResult: (md: string) => ({ html: `<p>${md}</p>` }) }));

import { ImageModerationBlockedError } from '@bike4mind/utils/imageModeration';
import {
  moderateExampleMedia,
  runTemplateExample,
  sampleFileName,
  type TemplateExampleRunDeps,
} from './templateExampleRun';
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
  deleteSample: vi.fn(async () => undefined),
  mediaInfo: vi.fn(async () => ({ bytes: 1000, mime: 'image/png' })),
  checkImage: vi.fn(async () => undefined),
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
  h.findTemplate.mockResolvedValue(null);
  h.settle.mockResolvedValue(true);
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
          'example.media': {
            kind: 'image',
            items: [{ key: 'generated/one.png', mime: 'image/png', bytes: 1000, moderation: 'clean' }],
          },
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

  it('moderates each harvested image as the run, recording a block instead of dropping the run', async () => {
    const blocked = new ImageModerationBlockedError([{ name: 'Explicit', confidence: 99 }] as never);
    const d = deps({ checkImage: vi.fn(async () => Promise.reject(blocked)) });
    await runTemplateExample(payload(), logger, d);
    expect(d.checkImage).toHaveBeenCalledWith(
      'generated/one.png',
      'image/png',
      { userId: 'author-1', sessionId: 'session-1', questId: 'quest-1', model: 'ops-model' },
      logger
    );
    expect(h.write.mock.calls[0][2].$set['example.media']).toEqual({
      kind: 'image',
      items: [{ key: 'generated/one.png', mime: 'image/png', bytes: 1000, moderation: 'blocked' }],
    });
    expect(h.fail).not.toHaveBeenCalled();
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
    'fails before any spend, saying so, when the chosen upload is %s',
    async moderationStatus => {
      h.findFile.mockResolvedValue({ userId: 'author-1', moderationStatus });
      const d = deps();
      const sampleFile = { fabFileId: 'up-1', name: 'brief.pdf', mime: 'application/pdf' };
      await runTemplateExample(payload({ takesFile: true, sampleFile }), logger, d);
      expect(d.storeSample).not.toHaveBeenCalled();
      expect(d.processQuest).not.toHaveBeenCalled();
      expect(h.fail).toHaveBeenCalledWith('l1', RUN_AT, expect.stringContaining('sample file you chose'));
      expect(h.release).toHaveBeenCalled();
    }
  );

  it('runs the approved snapshot, not the live skill, by its snapshot name', async () => {
    const d = deps();
    await runTemplateExample(payload(), logger, d);
    const [body, , mode] = vi.mocked(d.processQuest).mock.calls[0];
    expect(body.message).toBe('/launch-plan Plan the launch');
    expect(mode.skill).toEqual({ name: 'launch-plan', body: 'Plan it' });
    expect(mode.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ['the listing is no longer live', () => h.findListing.mockResolvedValue({ status: 'withdrawn' }), {}],
    ['the sample file cannot be written', () => undefined, { takesFile: true }],
  ])('fails the run and gives it back when %s, before any spend', async (_name, arrange, extra) => {
    arrange();
    const d = deps({ textModel: vi.fn(async () => ({ modelId: 'ops-model', complete: vi.fn(async () => ' ') })) });
    await runTemplateExample(payload(extra), logger, d);
    expect(d.processQuest).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
    expect(h.fail).toHaveBeenCalledWith('l1', RUN_AT, expect.any(String));
    expect(h.release).toHaveBeenCalledWith({ key: 'cap-key', expiresAt: '2026-11-26T00:00:00.000Z' });
  });

  it.each([
    ['the quest errored', () => h.findQuest.mockResolvedValue({ type: 'error', reply: 'boom' })],
    ['the reply is empty', () => h.findQuest.mockResolvedValue({ type: 'message', reply: '  ', replies: [] })],
    [
      'the reply is an artifact the page cannot show',
      () =>
        h.findQuest.mockResolvedValue({
          type: 'message',
          reply: '<artifact identifier="a" type="application/vnd.ant.react" title="App">x</artifact>',
          replies: [],
        }),
    ],
    ['the scan write conflicts', () => h.write.mockRejectedValue(new Error('The template changed'))],
  ])('fails the run but keeps the cap spent when %s after processing', async (_name, arrange) => {
    arrange();
    await runTemplateExample(payload(), logger, deps());
    expect(h.fail).toHaveBeenCalledWith('l1', RUN_AT, expect.any(String));
    expect(h.release).not.toHaveBeenCalled();
  });

  it('fails the run, settles the hidden quest and keeps the cap spent when processing throws', async () => {
    await runTemplateExample(
      payload(),
      logger,
      deps({ processQuest: vi.fn(async () => Promise.reject(new Error('provider down'))) })
    );
    expect(h.fail).toHaveBeenCalledWith('l1', RUN_AT, 'provider down');
    expect(h.settle).toHaveBeenCalledWith(
      'quest-1',
      expect.objectContaining({ status: 'stopped', type: 'error', reply: 'provider down' })
    );
    expect(h.release).not.toHaveBeenCalled();
  });

  it('leaves the cap alone when a newer run has superseded this one', async () => {
    h.fail.mockResolvedValue(false);
    h.findListing.mockResolvedValue({ status: 'withdrawn' });
    await runTemplateExample(payload(), logger, deps());
    expect(h.release).not.toHaveBeenCalled();
  });

  it('aborts and fails a run past its deadline, settling the hidden quest', async () => {
    let seen: AbortSignal | undefined;
    const processQuest = vi.fn(async (_body, _logger, mode) => {
      seen = mode.abortSignal;
      await new Promise(() => undefined);
    });
    await runTemplateExample(payload(), logger, deps({ processQuest, deadlineMs: 20 }));
    expect(seen?.aborted).toBe(true);
    expect(h.fail).toHaveBeenCalledWith('l1', RUN_AT, 'The example run took too long');
    expect(h.settle).toHaveBeenCalledWith('quest-1', expect.objectContaining({ type: 'error' }));
    expect(h.write).not.toHaveBeenCalled();
  });

  it('counts a turn that ended quietly at the deadline as late', async () => {
    const processQuest = vi.fn(
      async (_body, _logger, mode) =>
        new Promise<void>(resolve => mode.abortSignal.addEventListener('abort', () => resolve()))
    );
    await runTemplateExample(payload(), logger, deps({ processQuest, deadlineMs: 20 }));
    expect(h.fail).toHaveBeenCalledWith('l1', RUN_AT, 'The example run took too long');
  });

  describe('generated sample cleanup', () => {
    it('deletes the previous generated sample once the new example lands', async () => {
      h.findTemplate.mockResolvedValue({
        example: { sampleFile: { source: 'generated', fabFileId: 'old-sample', name: 'a.md', mime: 'text/markdown' } },
      });
      const d = deps();
      await runTemplateExample(payload({ takesFile: true }), logger, d);
      expect(d.deleteSample).toHaveBeenCalledTimes(1);
      expect(d.deleteSample).toHaveBeenCalledWith('author-1', 'old-sample');
    });

    it('never deletes an uploaded sample', async () => {
      h.findTemplate.mockResolvedValue({
        example: { sampleFile: { source: 'upload', fabFileId: 'up-1', name: 'a.pdf', mime: 'application/pdf' } },
      });
      const d = deps();
      await runTemplateExample(payload({ takesFile: true }), logger, d);
      expect(d.deleteSample).not.toHaveBeenCalled();
    });

    it('deletes the sample it generated when the run fails', async () => {
      const d = deps({ processQuest: vi.fn(async () => Promise.reject(new Error('provider down'))) });
      await runTemplateExample(payload({ takesFile: true }), logger, d);
      expect(d.deleteSample).toHaveBeenCalledWith('author-1', 'sample-file-1');
    });

    it('deletes the sample it generated when a newer run replaced this one', async () => {
      h.write.mockResolvedValue(null);
      h.findTemplate.mockResolvedValue({
        example: { sampleFile: { source: 'generated', fabFileId: 'old-sample', name: 'a.md', mime: 'text/markdown' } },
      });
      const d = deps();
      await runTemplateExample(payload({ takesFile: true }), logger, d);
      expect(d.deleteSample).toHaveBeenCalledTimes(1);
      expect(d.deleteSample).toHaveBeenCalledWith('author-1', 'sample-file-1');
    });
  });
});

describe('moderateExampleMedia', () => {
  const image = { key: 'a.png', mime: 'image/png', bytes: 1 };
  const video = { key: 'v.mp4', mime: 'video/mp4', bytes: 1, durationS: 5 };

  it.each([
    ['clean', async () => undefined],
    ['blocked', async () => Promise.reject(new ImageModerationBlockedError([] as never))],
    ['error', async () => Promise.reject(new Error('Rekognition throttled'))],
  ] as const)('records %s from the moderation check', async (verdict, check) => {
    expect(await moderateExampleMedia({ kind: 'image', items: [image] }, check)).toEqual({
      kind: 'image',
      items: [{ ...image, moderation: verdict }],
    });
  });

  it('leaves videos to their FabFile moderation and passes null through', async () => {
    const check = vi.fn();
    expect(await moderateExampleMedia({ kind: 'video', items: [video] }, check)).toEqual({
      kind: 'video',
      items: [video],
    });
    expect(check).not.toHaveBeenCalled();
    expect(await moderateExampleMedia(null, check)).toBeNull();
  });
});
