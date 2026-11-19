import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IDelegatedItem } from '@bike4mind/database';

const mocks = vi.hoisted(() => ({
  findItem: vi.fn(),
  markSettled: vi.fn(),
  markFailed: vi.fn(),
  claim: vi.fn(),
  releaseClaim: vi.fn(),
  findUser: vi.fn(),
  findFile: vi.fn(),
  findTexts: vi.fn(),
  getOperationsModel: vi.fn(),
  recordUsage: vi.fn(),
  payerCanFund: vi.fn(),
  accessDenied: vi.fn(),
  billedWebFetch: vi.fn(),
}));

vi.mock('@workers/utils/eventContext', () => ({ withEventContext: (handler: unknown) => handler }));
vi.mock('@bike4mind/server-utils/utils/eventBus', () => ({
  DelegationEvents: { Process: { schema: { parse: (properties: unknown) => properties } } },
}));
vi.mock('@bike4mind/database', () => ({
  delegatedItemRepository: {
    findById: mocks.findItem,
    claim: mocks.claim,
    releaseClaim: mocks.releaseClaim,
    markSettled: mocks.markSettled,
    markFailed: mocks.markFailed,
  },
  userRepository: { findById: mocks.findUser },
  fabFileRepository: { findByIdAndUserId: mocks.findFile },
  fabFileChunkRepository: { findTextsByFabFileId: mocks.findTexts },
}));
vi.mock('@bike4mind/server-utils/services/operationsModelService', () => ({
  OperationsModelService: { getOperationsModel: mocks.getOperationsModel },
}));
vi.mock('@bike4mind/server-utils/billing/billedWebTools', () => ({ billedWebFetch: mocks.billedWebFetch }));
vi.mock('@bike4mind/services/llm/tools/implementation/webfetch', () => ({
  webFetchBody: (result: { markdown: string }) => result.markdown,
}));
vi.mock('@bike4mind/services/userService/accountState', () => ({ aiAccessDeniedMessage: mocks.accessDenied }));
vi.mock('@workers/events/recordSessionOperationalUsage', () => ({ recordSessionOperationalUsage: mocks.recordUsage }));
vi.mock('@workers/events/sessionOperationalCreditGate', () => ({ payerCanFundSessionOperation: mocks.payerCanFund }));

import { ContentNotReadyError, handler, processDelegation, type DelegationProcessDeps } from './delegationProcess';

const createdAt = new Date('2026-11-19T00:00:00Z');
const soon = new Date(createdAt.getTime() + 30_000);
const later = new Date(createdAt.getTime() + 5 * 60_000);

const item = (overrides: Partial<IDelegatedItem> = {}): IDelegatedItem =>
  ({
    _id: { toString: () => 'g1' },
    userId: 'u1',
    intent: 'Summarize for the team',
    url: null,
    text: 'shared words',
    fileIds: [],
    status: 'pending',
    createdAt,
    ...overrides,
  }) as unknown as IDelegatedItem;

const handledReply = JSON.stringify({ outcome: 'handled', result: 'Summary for the team.' });

function makeDeps(overrides: Partial<DelegationProcessDeps> = {}) {
  return {
    now: () => later,
    items: {
      findById: vi.fn().mockResolvedValue(item()),
      claim: vi.fn().mockResolvedValue(true),
      releaseClaim: vi.fn().mockResolvedValue(undefined),
      markSettled: vi.fn().mockResolvedValue(true),
      markFailed: vi.fn().mockResolvedValue(true),
    },
    canRun: vi.fn().mockResolvedValue('ok'),
    fetchPage: vi.fn().mockResolvedValue('page text'),
    findFile: vi
      .fn()
      .mockResolvedValue({ fileName: 'deck.pdf', mimeType: 'application/pdf', moderationStatus: 'clean' }),
    fileText: vi.fn().mockResolvedValue('slide text'),
    complete: vi.fn().mockResolvedValue({ reply: handledReply, model: 'ops-model' }),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  } as DelegationProcessDeps & {
    items: Record<'findById' | 'claim' | 'releaseClaim' | 'markSettled' | 'markFailed', ReturnType<typeof vi.fn>>;
    complete: ReturnType<typeof vi.fn>;
    logger: Record<'info' | 'warn' | 'error', ReturnType<typeof vi.fn>>;
  };
}

const input = { delegationId: 'g1', userId: 'u1' };
const promptOf = (deps: ReturnType<typeof makeDeps>): string => deps.complete.mock.calls[0][2];

describe('processDelegation', () => {
  it('settles a handled item with the model result', async () => {
    const deps = makeDeps();
    await processDelegation(deps, input);
    expect(promptOf(deps)).toContain('Shared text:\nshared words');
    expect(deps.items.markSettled).toHaveBeenCalledWith(
      'g1',
      { status: 'handled', result: 'Summary for the team.', model: 'ops-model' },
      later
    );
  });

  it('settles a decision', async () => {
    const reply = JSON.stringify({ outcome: 'needs_decision', result: 'Approve the quote?' });
    const deps = makeDeps({ complete: vi.fn().mockResolvedValue({ reply, model: 'm' }) });
    await processDelegation(deps, input);
    expect(deps.items.markSettled).toHaveBeenCalledWith(
      'g1',
      expect.objectContaining({ status: 'needs_decision' }),
      later
    );
  });

  it("skips an item that is missing, someone else's or already settled", async () => {
    for (const found of [null, item({ userId: 'u2' }), item({ status: 'handled' })]) {
      const deps = makeDeps();
      deps.items.findById.mockResolvedValue(found);
      await processDelegation(deps, input);
      expect(deps.complete).not.toHaveBeenCalled();
      expect(deps.items.markFailed).not.toHaveBeenCalled();
    }
  });

  it('skips an item another delivery is already processing', async () => {
    const deps = makeDeps();
    deps.items.claim.mockResolvedValue(false);
    await processDelegation(deps, input);
    expect(deps.items.claim).toHaveBeenCalledWith('g1', later, 3 * 60 * 1000);
    expect(deps.complete).not.toHaveBeenCalled();
    expect(deps.items.markFailed).not.toHaveBeenCalled();
  });

  it('fails the item without a model call when the gate refuses', async () => {
    const deps = makeDeps({ canRun: vi.fn().mockResolvedValue('insufficient_credits') });
    await processDelegation(deps, input);
    expect(deps.items.markFailed).toHaveBeenCalledWith('g1', 'insufficient_credits', later);
    expect(deps.complete).not.toHaveBeenCalled();
  });

  it('fails the item on a malformed model reply', async () => {
    const deps = makeDeps({ complete: vi.fn().mockResolvedValue({ reply: 'not json', model: 'm' }) });
    await processDelegation(deps, input);
    expect(deps.items.markFailed).toHaveBeenCalledWith('g1', 'processing_failed', later);
    expect(deps.items.markSettled).not.toHaveBeenCalled();
  });

  it('reads the shared link, and goes ahead without it when it cannot be read', async () => {
    const withUrl = item({ url: 'https://example.com/r', text: null });
    const read = makeDeps({ fetchPage: vi.fn().mockResolvedValue('x'.repeat(20_000)) });
    read.items.findById.mockResolvedValue(withUrl);
    await processDelegation(read, input);
    expect(promptOf(read)).toContain('[truncated]');

    for (const error of [new Error('refused'), 'boom']) {
      const unread = makeDeps({ fetchPage: vi.fn().mockRejectedValue(error) });
      unread.items.findById.mockResolvedValue(withUrl);
      await processDelegation(unread, input);
      expect(promptOf(unread)).toContain('(the page could not be read)');
      expect(unread.items.markSettled).toHaveBeenCalled();
    }
  });

  it('describes each file it cannot read instead of failing', async () => {
    const files = {
      gone: null,
      blocked: { fileName: 'bad.pdf', moderationStatus: 'blocked' },
      photo: { fileName: 'photo.jpg', mimeType: 'image/jpeg', moderationStatus: 'clean' },
      doc: { fileName: 'deck.pdf', mimeType: 'application/pdf' },
    };
    const deps = makeDeps({
      findFile: vi.fn((id: string) => Promise.resolve(files[id as keyof typeof files])),
      fileText: vi.fn().mockResolvedValue('y'.repeat(9_000)),
    });
    deps.items.findById.mockResolvedValue(item({ fileIds: Object.keys(files) }));
    await processDelegation(deps, input);

    const prompt = promptOf(deps);
    expect(prompt).toContain('File "gone":\n(this file is no longer available)');
    expect(prompt).toContain('File "bad.pdf":\n(withheld by the content scan)');
    expect(prompt).toContain('File "photo.jpg":\n(an image; its picture cannot be read here)');
    expect(prompt).toContain('File "deck.pdf":\nyyy');
    expect(deps.fileText).toHaveBeenCalledOnce();
  });

  it("retries while a young item's file is still being extracted", async () => {
    for (const file of [
      { fileName: 'deck.pdf', moderationStatus: 'scanning' },
      { fileName: 'deck.pdf', moderationStatus: 'pending' },
      { fileName: 'deck.pdf', moderationStatus: 'clean' },
    ]) {
      const deps = makeDeps({
        now: () => soon,
        findFile: vi.fn().mockResolvedValue(file),
        fileText: vi.fn().mockResolvedValue(''),
      });
      deps.items.findById.mockResolvedValue(item({ fileIds: ['f1'] }));
      await expect(processDelegation(deps, input)).rejects.toBeInstanceOf(ContentNotReadyError);
      expect(deps.items.releaseClaim).toHaveBeenCalledWith('g1');
      expect(deps.items.markFailed).not.toHaveBeenCalled();
      expect(deps.complete).not.toHaveBeenCalled();
    }
  });

  it('goes ahead without the file text once the item is old enough', async () => {
    const deps = makeDeps({ fileText: vi.fn().mockResolvedValue('') });
    deps.items.findById.mockResolvedValue(item({ fileIds: ['f1'] }));
    await processDelegation(deps, input);
    expect(promptOf(deps)).toContain('(its text was not ready in time)');
    expect(deps.items.markSettled).toHaveBeenCalled();
  });
});

describe('delegation.process handler', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), updateMetadata: vi.fn() };
  const run = () =>
    (handler as unknown as (event: unknown, logger: unknown) => Promise<void>)({ properties: input }, logger);
  const llm = {
    complete: vi.fn(
      async (
        _model: string,
        _messages: unknown,
        _options: unknown,
        onChunk: (chunks: (string | null)[], info?: unknown) => Promise<void>
      ) => {
        await onChunk(['{"outcome": "handled", ', null], undefined);
        await onChunk(['"result": "Done."}'], { inputTokens: 10 });
      }
    ),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findItem.mockResolvedValue(item({ url: 'https://example.com/r', fileIds: ['f1'] }));
    mocks.claim.mockResolvedValue(true);
    mocks.findUser.mockResolvedValue({ id: 'u1' });
    mocks.accessDenied.mockReturnValue(null);
    mocks.payerCanFund.mockResolvedValue(true);
    mocks.billedWebFetch.mockResolvedValue({ title: 'Report', markdown: 'page body' });
    mocks.findFile.mockResolvedValue({ fileName: 'deck.pdf', mimeType: 'application/pdf', moderationStatus: 'clean' });
    mocks.findTexts.mockResolvedValue([
      { id: 'c1', text: 'one' },
      { id: 'c2', text: 'two' },
    ]);
    mocks.getOperationsModel.mockResolvedValue({ modelId: 'ops-model', llm, modelInfo: {} });
  });

  it('reads the content, runs the operations model, records usage and settles the item', async () => {
    await run();

    expect(mocks.billedWebFetch).toHaveBeenCalledWith(
      { caller: { user: { id: 'u1' }, logger }, source: 'system' },
      expect.objectContaining({ url: 'https://example.com/r' })
    );
    expect(mocks.findFile).toHaveBeenCalledWith('f1', 'u1');
    const prompt = llm.complete.mock.calls[0][1] as { content: string }[];
    expect(prompt[0].content).toContain('# Report\n\npage body');
    expect(prompt[0].content).toContain('File "deck.pdf":\none\ntwo');
    expect(mocks.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'g1', operation: 'delegated_item', completionInfo: { inputTokens: 10 } })
    );
    expect(mocks.markSettled).toHaveBeenCalledWith(
      'g1',
      { status: 'handled', result: 'Done.', model: 'ops-model' },
      expect.any(Date)
    );
  });

  it('uses the page body alone when the page has no title', async () => {
    mocks.billedWebFetch.mockResolvedValue({ markdown: 'untitled body' });
    await run();
    const prompt = llm.complete.mock.calls[0][1] as { content: string }[];
    expect(prompt[0].content).toContain('Page text:\nuntitled body');
  });

  it('skips the link when its owner is gone by the time it is read', async () => {
    mocks.findUser.mockResolvedValueOnce({ id: 'u1' }).mockResolvedValueOnce(null);
    await run();
    expect(mocks.billedWebFetch).not.toHaveBeenCalled();
    expect(mocks.markSettled).toHaveBeenCalled();
  });

  it.each([
    ['a missing user', () => mocks.findUser.mockResolvedValue(null), 'ai_access_held'],
    ['held AI access', () => mocks.accessDenied.mockReturnValue('held'), 'ai_access_held'],
    ['an unfunded balance', () => mocks.payerCanFund.mockResolvedValue(false), 'insufficient_credits'],
  ])('fails the item for %s', async (_label, arrange, reason) => {
    arrange();
    await run();
    expect(mocks.markFailed).toHaveBeenCalledWith('g1', reason, expect.any(Date));
    expect(mocks.getOperationsModel).not.toHaveBeenCalled();
  });
});
