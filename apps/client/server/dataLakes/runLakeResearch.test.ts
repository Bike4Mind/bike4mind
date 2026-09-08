import { describe, it, expect, vi, beforeEach } from 'vitest';
import { emptyResearchRunTotals } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  claimForExecution: vi.fn(),
  settleRun: vi.fn(),
  recordProgress: vi.fn(),
  findLakeById: vi.fn(),
  resolveWebSearchProvider: vi.fn(),
  executeResearchRun: vi.fn(),
  getEffectiveLLMApiKeys: vi.fn(),
  getAvailableModels: vi.fn(),
  judge: vi.fn(),
  fetchAndParseURL: vi.fn(),
  proposeDataLakeContent: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  apiKeyRepository: {},
  dataLakeProposalRepository: {},
  fabFileRepository: {},
  dataLakeRepository: { findById: h.findLakeById },
  dataLakeResearchRunRepository: {
    claimForExecution: h.claimForExecution,
    settleRun: h.settleRun,
    recordProgress: h.recordProgress,
  },
}));
vi.mock('@bike4mind/services', () => ({
  resolveWebSearchProvider: h.resolveWebSearchProvider,
  apiKeyService: { getEffectiveLLMApiKeys: h.getEffectiveLLMApiKeys },
  dataLakeService: { proposeDataLakeContent: h.proposeDataLakeContent },
  dataLakeResearchService: {
    executeResearchRun: h.executeResearchRun,
    RelevanceJudgeService: class {
      judge = h.judge;
    },
    RELEVANCE_JUDGE_DEFAULT_MODEL: 'default-judge-model',
  },
}));
vi.mock('@bike4mind/llm-adapters', () => ({ getAvailableModels: h.getAvailableModels }));
// fetchAndParseURL comes from fab-pipeline, not utils: the lint rule `no-restricted-imports` routes
// every caller there, and mocking the wrong module leaves the REAL fetcher in place - which fails
// closed to null and reads as a broken extraction contract rather than a broken mock.
vi.mock('@bike4mind/fab-pipeline', () => ({ fetchAndParseURL: h.fetchAndParseURL }));
vi.mock('@bike4mind/utils', () => ({ getSettingsByNames: vi.fn() }));

import { runLakeResearch } from './runLakeResearch';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  log: vi.fn(),
  error: vi.fn(),
  updateMetadata: vi.fn(),
} as never;

const levers = (overrides: Record<string, unknown> = {}) => ({
  query: 'coastal erosion',
  maxResults: 10,
  maxProposals: 5,
  allowedDomains: [],
  blockedDomains: [],
  minRelevance: 0.6,
  costCeilingMicroUsd: 50_000,
  proposedTags: [],
  ...overrides,
});

const claimedRun = (overrides: Record<string, unknown> = {}) => ({
  id: 'run-1',
  dataLakeId: 'lake-1',
  configId: 'config-1',
  levers: levers(),
  totals: emptyResearchRunTotals(),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.claimForExecution.mockResolvedValue(claimedRun());
  h.recordProgress.mockResolvedValue(undefined);
  h.findLakeById.mockResolvedValue({ id: 'lake-1', createdByUserId: 'owner-1' });
  h.resolveWebSearchProvider.mockResolvedValue({ name: 'serpapi', search: vi.fn(async () => []) });
  h.getEffectiveLLMApiKeys.mockResolvedValue({ openai: 'k' });
  h.getAvailableModels.mockResolvedValue([{ id: 'gpt-4.1-mini' }]);
  h.executeResearchRun.mockResolvedValue({
    totals: { ...emptyResearchRunTotals(), searchHits: 3, proposed: 1 },
    spentMicroUsd: 800,
    stopReason: 'exhausted',
  });
});

describe('runLakeResearch', () => {
  // The claim is the at-least-once guard. SQS redelivers, and a second pass would not merely write a
  // duplicate - it would spend a second cost ceiling.
  it('does nothing when the run is not claimable', async () => {
    h.claimForExecution.mockResolvedValue(null);

    expect(await runLakeResearch('run-1', logger)).toEqual({ claimed: false });
    expect(h.executeResearchRun).not.toHaveBeenCalled();
    expect(h.settleRun).not.toHaveBeenCalled();
  });

  it('settles a finished run with its stop reason, spend and totals', async () => {
    await runLakeResearch('run-1', logger);

    expect(h.settleRun).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ status: 'completed', stopReason: 'exhausted', spentMicroUsd: 800 })
    );
  });

  it('executes the levers snapshotted on the run row', async () => {
    h.claimForExecution.mockResolvedValue(claimedRun({ levers: levers({ maxProposals: 2 }) }));

    await runLakeResearch('run-1', logger);

    expect(h.executeResearchRun).toHaveBeenCalledWith(
      expect.objectContaining({ maxProposals: 2 }),
      'run-1',
      expect.anything()
    );
  });

  describe('terminal operator faults settle rather than throw', () => {
    // Throwing would burn the SQS deliveries and a DLQ entry on a message that can never succeed.
    it('names what an administrator must do when web search is unconfigured', async () => {
      h.resolveWebSearchProvider.mockResolvedValue(null);

      expect(await runLakeResearch('run-1', logger)).toEqual({ claimed: true });
      expect(h.settleRun).toHaveBeenCalledWith(
        'run-1',
        expect.objectContaining({ status: 'failed', error: expect.stringMatching(/Web search is not configured/) })
      );
      expect(h.executeResearchRun).not.toHaveBeenCalled();
    });

    it('settles when the lake went away between enqueue and execution', async () => {
      h.findLakeById.mockResolvedValue(null);

      expect(await runLakeResearch('run-1', logger)).toEqual({ claimed: true });
      expect(h.settleRun).toHaveBeenCalledWith(
        'run-1',
        expect.objectContaining({ status: 'failed', error: expect.stringMatching(/no longer exists/) })
      );
    });

    // A failed READ is not an answer of "deleted". Reporting a database outage as "the lake no
    // longer exists" names a cause that did not happen and hides the outage from the queue alarms.
    it('does not report a read fault as a deleted lake', async () => {
      h.findLakeById.mockRejectedValue(new Error('connection reset'));

      await expect(runLakeResearch('run-1', logger)).rejects.toThrow(/connection reset/);
      expect(h.settleRun).toHaveBeenCalledWith(
        'run-1',
        expect.objectContaining({ status: 'failed', error: 'connection reset' })
      );
      expect(h.settleRun).not.toHaveBeenCalledWith(
        'run-1',
        expect.objectContaining({ error: expect.stringMatching(/no longer exists/) })
      );
    });
  });

  // A run that dies after four judgments really did spend four judgments. Reporting 0 would make the
  // ceiling look untouched on the very run that proves it is needed.
  it('records the spend already reported when the run dies mid-flight', async () => {
    h.executeResearchRun.mockImplementation(
      async (_levers: unknown, _runId: string, ports: { onProgress: (s: number, t: unknown) => Promise<void> }) => {
        await ports.onProgress(650, { ...emptyResearchRunTotals(), proposed: 2 });
        throw new Error('the provider exploded');
      }
    );

    await expect(runLakeResearch('run-1', logger)).rejects.toThrow(/exploded/);

    expect(h.settleRun).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({
        status: 'failed',
        spentMicroUsd: 650,
        totals: expect.objectContaining({ proposed: 2 }),
        error: 'the provider exploded',
      })
    );
  });

  // The claim is a one-way door, so a run left `running` could never be re-claimed by a redelivery
  // and would block every later run behind the one-at-a-time guard.
  it('rethrows after settling, so the fault is still visible to the queue', async () => {
    h.executeResearchRun.mockRejectedValue(new Error('boom'));

    await expect(runLakeResearch('run-1', logger)).rejects.toThrow(/boom/);
    expect(h.settleRun).toHaveBeenCalledWith('run-1', expect.objectContaining({ status: 'failed' }));
  });

  describe('the judge model lever', () => {
    const judgeWith = async (configuredModel?: string) => {
      h.claimForExecution.mockResolvedValue(claimedRun({ levers: levers({ model: configuredModel }) }));
      let judgeCall: Record<string, unknown> | undefined;
      h.judge.mockImplementation(async (args: Record<string, unknown>) => {
        judgeCall = args;
        return { relevance: 1, costMicroUsd: 0 };
      });
      h.executeResearchRun.mockImplementation(
        async (_l: unknown, _r: string, ports: { judge: (c: unknown) => Promise<unknown> }) => {
          await ports.judge({ title: 't', url: 'https://example.com', snippet: 's' });
          return { totals: emptyResearchRunTotals(), spentMicroUsd: 0, stopReason: 'exhausted' };
        }
      );
      await runLakeResearch('run-1', logger);
      return judgeCall;
    };

    it('uses the configured model when the deployment still offers it', async () => {
      expect((await judgeWith('gpt-4.1-mini'))?.model).toBe('gpt-4.1-mini');
    });

    // Falling back beats failing the whole run over a model that was retired since the config was
    // saved.
    it('falls back and warns when the configured model is gone', async () => {
      expect((await judgeWith('a-retired-model'))?.model).toBe('default-judge-model');
      expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/falling back/), expect.anything());
    });

    it('uses the default when the config names no model', async () => {
      expect((await judgeWith(undefined))?.model).toBe('default-judge-model');
    });

    // The run spends against the LAKE, and a scheduled v2 run has no human behind it at all.
    it('attributes the spend to the lake owner, not to whoever pressed Run', async () => {
      expect((await judgeWith('gpt-4.1-mini'))?.endUserId).toBe('owner-1');
    });
  });

  describe('the extraction contract', () => {
    const fetchVia = async (parsed: unknown) => {
      h.fetchAndParseURL.mockResolvedValue(parsed);
      let fetched: unknown;
      h.executeResearchRun.mockImplementation(
        async (_l: unknown, _r: string, ports: { fetchSource: (u: string) => Promise<unknown> }) => {
          fetched = await ports.fetchSource('https://example.com/a');
          return { totals: emptyResearchRunTotals(), spentMicroUsd: 0, stopReason: 'exhausted' };
        }
      );
      await runLakeResearch('run-1', logger);
      return fetched;
    };

    // Passing textContent through verbatim is what makes the proposal's hash comparable with the
    // one the ingestion door would compute for the same URL.
    it('passes the extracted text through for a text source', async () => {
      expect(await fetchVia({ title: 'A page', textContent: 'body text', mimeType: 'text/plain' })).toEqual({
        title: 'A page',
        text: 'body text',
      });
    });

    // For a PDF, textContent is the raw buffer and the chunker extracts with a PDF parser - hashing
    // what we hold would fingerprint bytes the door will never produce.
    it('sends no text for a PDF, leaving source-keyed dedup to do the work', async () => {
      expect(await fetchVia({ title: 'A report', textContent: 'JVBERi0x...', mimeType: 'application/pdf' })).toEqual({
        title: 'A report',
        text: undefined,
      });
    });

    it('fails soft on a dead link, costing the candidate rather than the run', async () => {
      h.fetchAndParseURL.mockRejectedValue(new Error('404'));
      let fetched: unknown = 'unset';
      h.executeResearchRun.mockImplementation(
        async (_l: unknown, _r: string, ports: { fetchSource: (u: string) => Promise<unknown> }) => {
          fetched = await ports.fetchSource('https://example.com/gone');
          return { totals: emptyResearchRunTotals(), spentMicroUsd: 0, stopReason: 'exhausted' };
        }
      );

      await runLakeResearch('run-1', logger);

      expect(fetched).toBeNull();
      expect(h.settleRun).toHaveBeenCalledWith('run-1', expect.objectContaining({ status: 'completed' }));
    });
  });

  it('keeps a failed progress write from ending an otherwise working run', async () => {
    h.recordProgress.mockRejectedValue(new Error('mongo hiccup'));
    h.executeResearchRun.mockImplementation(
      async (_l: unknown, _r: string, ports: { onProgress: (s: number, t: unknown) => Promise<void> }) => {
        await ports.onProgress(10, emptyResearchRunTotals());
        return { totals: emptyResearchRunTotals(), spentMicroUsd: 10, stopReason: 'exhausted' };
      }
    );

    await runLakeResearch('run-1', logger);

    expect(h.settleRun).toHaveBeenCalledWith('run-1', expect.objectContaining({ status: 'completed' }));
    // Logged, not dropped: otherwise "the run card never moved" is indistinguishable from "the
    // progress write never fired".
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/progress write failed/), expect.anything());
  });
});
