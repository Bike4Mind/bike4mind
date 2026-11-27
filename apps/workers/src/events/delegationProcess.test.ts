import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@bike4mind/observability';
import type { IDelegatedItem } from '@bike4mind/database';

const mocks = vi.hoisted(() => ({
  receiveQueue: vi.fn(),
  deleteQueue: vi.fn(),
  findItem: vi.fn(),
  markSettledOwned: vi.fn(),
  markFailedOwned: vi.fn(),
  claim: vi.fn(),
  renewClaim: vi.fn(),
  fenceClaim: vi.fn(),
  releaseClaim: vi.fn(),
  releaseClaimOwned: vi.fn(),
  findUser: vi.fn(),
  findFile: vi.fn(),
  findTexts: vi.fn(),
  getOperationsModel: vi.fn(),
  recordUsage: vi.fn(),
  payerCanFund: vi.fn(),
  accessDenied: vi.fn(),
  billedWebFetch: vi.fn(),
}));

vi.mock('@bike4mind/server-utils/utils/sqs', () => ({
  receiveFromQueue: mocks.receiveQueue,
  deleteFromQueue: mocks.deleteQueue,
}));

vi.mock('@workers/utils/eventContext', () => ({ withEventContext: (handler: unknown) => handler }));
vi.mock('@bike4mind/server-utils/utils/eventBus', () => ({
  DelegationEvents: { Process: { schema: { parse: (properties: unknown) => properties } } },
}));
vi.mock('@bike4mind/database', () => ({
  withTransaction: async (body: (session: object) => Promise<unknown>) => body({}),
  delegatedItemRepository: {
    findById: mocks.findItem,
    claim: mocks.claim,
    renewClaim: mocks.renewClaim,
    fenceClaim: mocks.fenceClaim,
    releaseClaim: mocks.releaseClaim,
    releaseClaimOwned: mocks.releaseClaimOwned,
    markSettledOwned: mocks.markSettledOwned,
    markFailedOwned: mocks.markFailedOwned,
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

import { SelfHostWorker } from '../selfhost/selfHostWorker';
import {
  ContentNotReadyError,
  DelegationClaimBusyError,
  handler,
  processDelegation,
  type DelegationProcessDeps,
} from './delegationProcess';

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
      renewClaim: vi
        .fn()
        .mockImplementation(
          async (_id: string, _token: string, _expiry: Date, now: Date, ms: number) => new Date(now.getTime() + ms)
        ),
      fenceClaim: vi.fn().mockResolvedValue(true),
      releaseClaim: vi.fn().mockResolvedValue(undefined),
      releaseClaimOwned: vi.fn().mockResolvedValue(true),
      markSettledOwned: vi.fn().mockResolvedValue(true),
      markFailedOwned: vi.fn().mockResolvedValue(true),
    },
    canRun: vi.fn().mockResolvedValue('ok'),
    fetchPage: vi.fn().mockResolvedValue('page text'),
    findFile: vi
      .fn()
      .mockResolvedValue({ fileName: 'deck.pdf', mimeType: 'application/pdf', moderationStatus: 'clean' }),
    fileText: vi.fn().mockResolvedValue('slide text'),
    complete: vi.fn().mockResolvedValue({
      reply: handledReply,
      model: 'ops-model',
      recordUsage: vi.fn().mockResolvedValue(undefined),
    }),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  } as DelegationProcessDeps & {
    items: Record<
      | 'findById'
      | 'claim'
      | 'renewClaim'
      | 'fenceClaim'
      | 'releaseClaim'
      | 'releaseClaimOwned'
      | 'markSettledOwned'
      | 'markFailedOwned',
      ReturnType<typeof vi.fn>
    >;
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
    expect(deps.items.markSettledOwned).toHaveBeenCalledWith(
      'g1',
      expect.any(String),
      { status: 'handled', result: 'Summary for the team.', model: 'ops-model' },
      later,
      expect.anything()
    );
  });

  it('settles a decision', async () => {
    const reply = JSON.stringify({ outcome: 'needs_decision', result: 'Approve the quote?' });
    const deps = makeDeps({
      complete: vi.fn().mockResolvedValue({ reply, model: 'm', recordUsage: vi.fn().mockResolvedValue(undefined) }),
    });
    await processDelegation(deps, input);
    expect(deps.items.markSettledOwned).toHaveBeenCalledWith(
      'g1',
      expect.any(String),
      expect.objectContaining({ status: 'needs_decision' }),
      later,
      expect.anything()
    );
  });

  it("skips an item that is missing, someone else's or already settled", async () => {
    for (const found of [null, item({ userId: 'u2' }), item({ status: 'handled' })]) {
      const deps = makeDeps();
      deps.items.findById.mockResolvedValue(found);
      await processDelegation(deps, input);
      expect(deps.complete).not.toHaveBeenCalled();
      expect(deps.items.markFailedOwned).not.toHaveBeenCalled();
    }
  });

  it('retains a delivery while another attempt is still processing', async () => {
    const deps = makeDeps();
    deps.items.claim.mockResolvedValue(false);
    await expect(processDelegation(deps, input)).rejects.toBeInstanceOf(DelegationClaimBusyError);
    expect(deps.items.claim).toHaveBeenCalledWith('g1', later, 3 * 60 * 1000, expect.any(String));
    expect(deps.complete).not.toHaveBeenCalled();
    expect(deps.items.markFailedOwned).not.toHaveBeenCalled();
  });

  it('fails the item without a model call when the gate refuses', async () => {
    const deps = makeDeps({ canRun: vi.fn().mockResolvedValue('insufficient_credits') });
    await processDelegation(deps, input);
    expect(deps.items.markFailedOwned).toHaveBeenCalledWith(
      'g1',
      expect.any(String),
      'insufficient_credits',
      later,
      expect.anything()
    );
    expect(deps.complete).not.toHaveBeenCalled();
  });

  it('fails the item on a malformed model reply', async () => {
    const deps = makeDeps({
      complete: vi
        .fn()
        .mockResolvedValue({ reply: 'not json', model: 'm', recordUsage: vi.fn().mockResolvedValue(undefined) }),
    });
    await processDelegation(deps, input);
    expect(deps.items.markFailedOwned).toHaveBeenCalledWith(
      'g1',
      expect.any(String),
      'processing_failed',
      later,
      expect.anything()
    );
    expect(deps.items.markSettledOwned).not.toHaveBeenCalled();
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
      expect(unread.items.markSettledOwned).toHaveBeenCalled();
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
      expect(deps.items.releaseClaim).toHaveBeenCalledWith(
        'g1',
        new Date(soon.getTime() + 3 * 60 * 1000),
        expect.any(String)
      );
      expect(deps.items.markFailedOwned).not.toHaveBeenCalled();
      expect(deps.complete).not.toHaveBeenCalled();
    }
  });

  it('hands the lease back when an unexpected error escapes, so the retry is not skipped', async () => {
    const outage = new Error('mongo unavailable');
    const gateDeps = makeDeps({ canRun: vi.fn().mockRejectedValue(outage) });
    await expect(processDelegation(gateDeps, input)).rejects.toBe(outage);
    expect(gateDeps.items.releaseClaim).toHaveBeenCalledWith(
      'g1',
      new Date(later.getTime() + 3 * 60 * 1000),
      expect.any(String)
    );

    const markDeps = makeDeps({ complete: vi.fn().mockRejectedValue(new Error('model down')) });
    markDeps.items.markFailedOwned.mockRejectedValue(outage);
    markDeps.items.releaseClaim.mockRejectedValue(new Error('still down'));
    await expect(processDelegation(markDeps, input)).rejects.toBe(outage);
    expect(markDeps.logger.error).toHaveBeenCalledWith(
      '[Delegation] could not release the claim',
      expect.objectContaining({ delegationId: 'g1' })
    );
  });

  it('does not hand a billed run back for a retry when its outcome cannot be saved', async () => {
    const outage = new Error('mongo unavailable');
    const deps = makeDeps();
    deps.items.markSettledOwned.mockRejectedValue(outage);
    deps.items.markFailedOwned.mockRejectedValue(outage);

    await expect(processDelegation(deps, input)).resolves.toBeUndefined();
    expect(deps.complete).toHaveBeenCalledOnce();
    expect(deps.items.releaseClaim).not.toHaveBeenCalled();
    expect(deps.logger.error).toHaveBeenCalledWith(
      '[Delegation] could not record the outcome; leaving the item to the stale sweep',
      expect.objectContaining({ delegationId: 'g1', markError: outage })
    );
  });

  it('marks the still-extracting retry as an expected 4xx so it logs at warn', () => {
    expect(new ContentNotReadyError('g1').statusCode).toBe(409);
  });

  it('goes ahead without the file text once the item is old enough', async () => {
    const deps = makeDeps({ fileText: vi.fn().mockResolvedValue('') });
    deps.items.findById.mockResolvedValue(item({ fileIds: ['f1'] }));
    await processDelegation(deps, input);
    expect(promptOf(deps)).toContain('(its text was not ready in time)');
    expect(deps.items.markSettledOwned).toHaveBeenCalled();
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
    mocks.markSettledOwned.mockResolvedValue(true);
    mocks.markFailedOwned.mockResolvedValue(true);
    mocks.fenceClaim.mockResolvedValue(true);
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
    expect(llm.complete.mock.calls[0][2]).toMatchObject({ abortSignal: expect.any(AbortSignal) });
    expect(mocks.markSettledOwned.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.recordUsage.mock.invocationCallOrder[0]
    );
    expect(mocks.markSettledOwned).toHaveBeenCalledWith(
      'g1',
      expect.any(String),
      { status: 'handled', result: 'Done.', model: 'ops-model' },
      expect.any(Date),
      expect.anything()
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
    expect(mocks.markSettledOwned).toHaveBeenCalled();
  });

  it.each([
    ['a missing user', () => mocks.findUser.mockResolvedValue(null), 'ai_access_held'],
    ['held AI access', () => mocks.accessDenied.mockReturnValue('held'), 'ai_access_held'],
    ['an unfunded balance', () => mocks.payerCanFund.mockResolvedValue(false), 'insufficient_credits'],
  ])('fails the item for %s', async (_label, arrange, reason) => {
    arrange();
    await run();
    expect(mocks.markFailedOwned).toHaveBeenCalledWith(
      'g1',
      expect.any(String),
      reason,
      expect.any(Date),
      expect.anything()
    );
    expect(mocks.getOperationsModel).not.toHaveBeenCalled();
  });
});

describe('renewed delegation ownership with a signal-ignoring SDK', () => {
  afterEach(() => vi.useRealTimers());
  const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => {
      resolve = done;
    });
    return { promise, resolve };
  };
  function sharedDeps() {
    let owner: string | null = null;
    let expiry = 0;
    let pending = true;
    const usage = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ now: () => new Date() });
    deps.items.claim.mockImplementation(async (_id: string, now: Date, ms: number, token: string) => {
      if (!pending || (owner !== null && expiry > now.getTime())) return false;
      owner = token;
      expiry = now.getTime() + ms;
      return true;
    });
    deps.items.renewClaim.mockImplementation(
      async (_id: string, token: string, expected: Date, now: Date, ms: number) => {
        if (!pending || token !== owner || expiry !== expected.getTime() || expiry <= now.getTime()) return null;
        expiry = now.getTime() + ms;
        return new Date(expiry);
      }
    );
    deps.items.markSettledOwned.mockImplementation(async (_id: string, token: string) => {
      if (!pending || token !== owner || expiry <= Date.now()) return false;
      pending = false;
      return true;
    });
    deps.complete.mockResolvedValue({ reply: handledReply, model: 'ops-model', recordUsage: usage });
    return { deps, usage };
  }
  it('renews a healthy six-minute model so redelivery at300s starts no second provider or charge', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(later);
    const { deps, usage } = sharedDeps();
    const sdk = deferred<Awaited<ReturnType<DelegationProcessDeps['complete']>>>();
    deps.complete.mockImplementationOnce(() => sdk.promise);
    const first = processDelegation(deps, input);
    await vi.advanceTimersByTimeAsync(300_000);
    await expect(processDelegation(deps, input)).rejects.toBeInstanceOf(DelegationClaimBusyError);
    expect(deps.complete).toHaveBeenCalledTimes(1);
    expect(usage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    sdk.resolve({ reply: handledReply, model: 'ops-model', recordUsage: usage });
    await first;
    expect(usage).toHaveBeenCalledTimes(1);
    expect(deps.items.markSettledOwned).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['null', 'error'] as const)(
    'rejects a late signal-ignoring A after %s renewal and B takeover',
    async kind => {
      vi.useFakeTimers();
      vi.setSystemTime(later);
      const { deps, usage } = sharedDeps();
      const sdk = deferred<Awaited<ReturnType<DelegationProcessDeps['complete']>>>();
      const staleUsage = vi.fn().mockResolvedValue(undefined);
      deps.complete.mockImplementationOnce(() => sdk.promise);
      if (kind === 'null') deps.items.renewClaim.mockResolvedValueOnce(null);
      else deps.items.renewClaim.mockRejectedValueOnce(new Error('renewal acknowledgement unknown'));
      const first = processDelegation(deps, input);
      await vi.advanceTimersByTimeAsync(60_000);
      const signal = deps.complete.mock.calls[0][3] as AbortSignal;
      expect(signal.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(240_000);
      await processDelegation(deps, input);
      expect(usage).toHaveBeenCalledTimes(1);
      const terminalCalls = deps.items.markSettledOwned.mock.calls.length;
      sdk.resolve({ reply: handledReply, model: 'ops-model', recordUsage: staleUsage });
      await first;
      expect(staleUsage).not.toHaveBeenCalled();
      expect(deps.items.markSettledOwned).toHaveBeenCalledTimes(terminalCalls);
      expect(deps.items.markFailedOwned).not.toHaveBeenCalled();
      expect(deps.items.releaseClaim).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    }
  );
  it('drains a held renewal before releasing the latest expiry on content409', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(soon);
    const extracted = deferred<string>();
    const renewed = deferred<Date | null>();
    const deps = makeDeps({ now: () => new Date(), fileText: vi.fn(() => extracted.promise) });
    deps.items.findById.mockResolvedValue(item({ fileIds: ['f1'] }));
    deps.items.renewClaim.mockImplementationOnce(() => renewed.promise);
    const outcome = processDelegation(deps, input).catch(error => error as unknown);
    await vi.advanceTimersByTimeAsync(60_000);
    extracted.resolve('');
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.items.releaseClaim).not.toHaveBeenCalled();
    const expiry = new Date(Date.now() + 180_000);
    renewed.resolve(expiry);
    expect(await outcome).toBeInstanceOf(ContentNotReadyError);
    expect(deps.items.releaseClaim).toHaveBeenCalledWith('g1', expiry, expect.any(String));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not record usage when the owned terminal CAS rejects buffered output', async () => {
    const deps = makeDeps();
    const recordUsage = vi.fn().mockResolvedValue(undefined);
    deps.complete.mockResolvedValue({ reply: handledReply, model: 'ops-model', recordUsage });
    deps.items.markSettledOwned.mockResolvedValue(false);
    await processDelegation(deps, input);
    expect(recordUsage).not.toHaveBeenCalled();
    expect(deps.items.markFailedOwned).not.toHaveBeenCalled();
    expect(deps.items.releaseClaim).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'retries pre-provider uncertainty after draining renewal; release failure=%s',
    async releaseFails => {
      vi.useFakeTimers();
      vi.setSystemTime(soon);
      const extracted = deferred<string>();
      const deps = makeDeps({ now: () => new Date(), fileText: vi.fn(() => extracted.promise) });
      deps.items.findById.mockResolvedValue(item({ fileIds: ['f1'] }));
      deps.items.renewClaim.mockRejectedValueOnce(new Error('renewal acknowledgement unknown'));
      if (releaseFails) deps.items.releaseClaimOwned.mockRejectedValueOnce(new Error('still unavailable'));
      const outcome = processDelegation(deps, input).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(deps.items.releaseClaimOwned).not.toHaveBeenCalled();
      extracted.resolve('ready');
      expect(await outcome).toMatchObject({ name: 'DelegationLeaseUncertainError' });
      expect(deps.items.releaseClaimOwned).toHaveBeenCalledWith('g1', expect.any(String));
      expect(deps.items.releaseClaim).not.toHaveBeenCalled();
      expect(deps.complete).not.toHaveBeenCalled();
      expect(deps.items.markFailedOwned).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it('consumes a busy delivery only after the item has become terminal', async () => {
    const deps = makeDeps();
    deps.items.claim.mockResolvedValue(false);
    deps.items.findById.mockResolvedValueOnce(item()).mockResolvedValueOnce(item({ status: 'handled' }));
    await processDelegation(deps, input);
    expect(deps.complete).not.toHaveBeenCalled();
  });

  it('retries an uncertain page admission without starting the provider', async () => {
    const deps = makeDeps({
      fetchPage: vi.fn<DelegationProcessDeps['fetchPage']>(async (_userId, _url, admit) => {
        await admit();
        return 'unreachable';
      }),
    });
    deps.items.findById.mockResolvedValue(item({ url: 'https://example.invalid/report' }));
    deps.items.fenceClaim.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(processDelegation(deps, input)).rejects.toMatchObject({ name: 'DelegationLeaseUncertainError' });
    expect(deps.items.releaseClaimOwned).toHaveBeenCalledWith('g1', expect.any(String));
    expect(deps.complete).not.toHaveBeenCalled();
    expect(deps.items.markFailedOwned).not.toHaveBeenCalled();
  });
});

describe('delegation transport acknowledgement', () => {
  it.each(['busy', 'uncertain', 'terminal'] as const)(
    'retains unfinished %s work and consumes terminal work',
    async state => {
      const deps = makeDeps({
        fetchPage: vi.fn<DelegationProcessDeps['fetchPage']>(async (_userId, _url, admit) => {
          await admit();
          return 'unreachable';
        }),
      });
      if (state === 'busy') deps.items.claim.mockResolvedValue(false);
      if (state === 'uncertain') {
        deps.items.findById.mockResolvedValue(item({ url: 'https://example.invalid/report' }));
        deps.items.fenceClaim.mockRejectedValueOnce(new Error('database unavailable'));
      }
      if (state === 'terminal') deps.items.findById.mockResolvedValue(item({ status: 'handled' }));
      const worker = new SelfHostWorker(deps.logger as unknown as Logger);
      mocks.deleteQueue.mockReset().mockResolvedValue(undefined);
      let received = false;
      mocks.receiveQueue.mockImplementation(async () => {
        if (received) {
          void worker.stop();
          return [];
        }
        received = true;
        return [
          { MessageId: 'delivery', ReceiptHandle: 'receipt', Body: '{}', Attributes: { ApproximateReceiveCount: '1' } },
        ];
      });
      const dispatch = vi.fn(async () => processDelegation(deps, input));
      worker.registerQueueHandler('delegation', 'http://queue.invalid/delegation', dispatch);
      worker.start();
      try {
        await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
        await worker.stop();
        expect(mocks.deleteQueue).toHaveBeenCalledTimes(state === 'terminal' ? 1 : 0);
        expect(deps.complete).not.toHaveBeenCalled();
      } finally {
        await worker.stop();
      }
    }
  );
});
