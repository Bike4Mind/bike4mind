import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LAKE_MEMORY_FINDING_SOURCE_PREFIX } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  getSettingsValue: vi.fn(),
  getEffectiveLLMApiKeys: vi.fn(async () => ({})),
  createLedgerAppendSession: vi.fn(),
  createMementoEmbedder: vi.fn(),
  append: vi.fn(async () => true),
  embed: vi.fn(async () => [0.1, 0.2]),
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { getSettingsValue: h.getSettingsValue },
  apiKeyRepository: {},
}));
vi.mock('@bike4mind/services', () => ({
  apiKeyService: { getEffectiveLLMApiKeys: h.getEffectiveLLMApiKeys },
}));
vi.mock('@bike4mind/utils', () => ({ getSettingsByNames: vi.fn() }));
vi.mock('@server/memory/mementoLedgerMirror', () => ({ createLedgerAppendSession: h.createLedgerAppendSession }));
vi.mock('@server/memory/mementoEmbedder', () => ({ createMementoEmbedder: h.createMementoEmbedder }));

import { recordFindingResolutionBelief, composeFindingResolutionFact } from './recordFindingResolutionBelief';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const lake = {
  id: 'lakeDoc1',
  datalakeTag: 'datalake:acme-research',
  createdByUserId: 'lake-creator',
  lakeMemoryEnabled: true,
};

const finding = {
  id: 'finding-7',
  lakeId: 'lakeDoc1',
  kind: 'metric-disagreement',
  subject: 'q3 revenue',
  sources: [
    { fabFileId: 'file-a', fileName: 'q3-v1.pdf', excerpt: 'revenue was 4.2m' },
    { fabFileId: 'file-b', fileName: 'q3-v2.pdf', excerpt: 'revenue was 4.4m' },
  ],
};

// The module takes full Mongoose documents; these fixtures carry only the fields it reads, so the
// call site is cast the way this directory's sibling suites cast theirs.
const run = (overrides: Record<string, unknown> = {}) =>
  recordFindingResolutionBelief(
    {
      lake,
      finding,
      status: 'resolved',
      resolution: 'Different fiscal years; both are current.',
      ...overrides,
    } as never,
    { logger } as never
  );

beforeEach(() => {
  vi.clearAllMocks();
  h.getSettingsValue.mockResolvedValue(true);
  h.getEffectiveLLMApiKeys.mockResolvedValue({});
  h.append.mockResolvedValue(true);
  h.embed.mockResolvedValue([0.1, 0.2]);
  h.createMementoEmbedder.mockReturnValue(h.embed);
  h.createLedgerAppendSession.mockResolvedValue({ append: h.append });
});

describe('recordFindingResolutionBelief (#3049)', () => {
  it('writes under the LAKE principal, keyed to the lake tag and encrypted to the lake creator', async () => {
    // Not the curator. A belief under the curator's own principal is invisible to `recallLakeMemory`,
    // which reads `{ kind: 'lake', id: datalakeTag }` under the lake's own DEK owner - so the next
    // session hitting the same confusion would learn nothing, which is the bug this issue is about.
    await expect(run()).resolves.toEqual({ recorded: true });

    expect(h.createLedgerAppendSession).toHaveBeenCalledTimes(1);
    const [sessionParams] = h.createLedgerAppendSession.mock.calls[0];
    expect(sessionParams.principal).toEqual({ kind: 'lake', id: 'datalake:acme-research' });
    expect(sessionParams.ownerUserId).toBe('lake-creator');
    expect(sessionParams.startedAt).toBeInstanceOf(Date);
  });

  it('claims the human-reviewed tier, which only a human-authored belief may', async () => {
    await run();

    expect(h.append.mock.calls[0][0].evidenceTier).toBe('human-reviewed');
  });

  it('carries provenance for the source documents AND the finding', async () => {
    await run();

    const { sources } = h.append.mock.calls[0][0];
    expect(sources).toEqual(['file-a', 'file-b', `${LAKE_MEMORY_FINDING_SOURCE_PREFIX}finding-7`]);
  });

  it('keeps at least one real document id, so the belief survives the recall reachability gate', async () => {
    // `recallLakeMemory` drops a belief whose sources are ALL unreachable, and a `finding:` ref can
    // never resolve to a FabFile. A belief carrying only that ref would be written and then never
    // read - the exact silent failure this assertion exists to catch if the source list is ever
    // narrowed to "just the provenance ref".
    await run();

    const { sources } = h.append.mock.calls[0][0];
    expect(sources.filter((s: string) => !s.startsWith(LAKE_MEMORY_FINDING_SOURCE_PREFIX))).toEqual([
      'file-a',
      'file-b',
    ]);
  });

  it('de-duplicates repeated document ids without dropping the finding ref', async () => {
    await run({ finding: { ...finding, sources: [finding.sources[0], finding.sources[0]] } });

    expect(h.append.mock.calls[0][0].sources).toEqual(['file-a', `${LAKE_MEMORY_FINDING_SOURCE_PREFIX}finding-7`]);
  });

  it('refuses to invent a belief when the curator left no note', async () => {
    // The issue's guardrail: a belief means a human decided. A bare button click is a status change,
    // not a sentence anyone wrote, and synthesizing one would put words in a curator's mouth at the
    // top of the evidence ladder.
    await expect(run({ resolution: null })).resolves.toEqual({ recorded: false, reason: 'no-resolution' });
    await expect(run({ resolution: '   ' })).resolves.toEqual({ recorded: false, reason: 'no-resolution' });
    expect(h.createLedgerAppendSession).not.toHaveBeenCalled();
  });

  it('honours both lake-memory gates, and reaches nothing when either is off', async () => {
    h.getSettingsValue.mockResolvedValue(false);
    await expect(run()).resolves.toEqual({ recorded: false, reason: 'platform-disabled' });

    h.getSettingsValue.mockResolvedValue(true);
    await expect(run({ lake: { ...lake, lakeMemoryEnabled: false } })).resolves.toEqual({
      recorded: false,
      reason: 'lake-disabled',
    });

    expect(h.createLedgerAppendSession).not.toHaveBeenCalled();
  });

  it('degrades on an UNREADABLE gate without calling it disabled, and leaves a trace', async () => {
    // Opposite of the extraction queue handler, which lets the lookup throw so SQS retries. There is
    // no retry behind a curator's click and the resolution is already committed, so this degrades -
    // but a failed READ is not a resolved false. Reporting it as `platform-disabled` would send an
    // operator hunting a setting nobody changed, and this is the only path where the function
    // declines without the ledger ever hearing about it, so the log is the sole evidence it ran.
    h.getSettingsValue.mockRejectedValue(new Error('mongo blip'));

    await expect(run()).resolves.toEqual({ recorded: false, reason: 'memory-gate-unreadable' });
    expect(logger.warn).toHaveBeenCalled();
    expect(h.createLedgerAppendSession).not.toHaveBeenCalled();
  });

  it('checks the per-lake flag before paying for the settings read', async () => {
    // The lake flag is already in hand; the platform read is a round trip whose answer cannot change
    // the outcome once the lake has opted out. Gate the work, not the use.
    await run({ lake: { ...lake, lakeMemoryEnabled: false } });

    expect(h.getSettingsValue).not.toHaveBeenCalled();
  });

  it('warns when the embed fails, so a permanently vectorless belief is diagnosable', async () => {
    // No backfill re-embeds a lake principal, so this belief ranks on lexical overlap forever. That
    // is survivable but it must not be invisible.
    h.embed.mockRejectedValue(new Error('embedding provider down'));

    await run();

    expect(logger.warn).toHaveBeenCalled();
  });

  it('skips a lake with no memory principal instead of writing under a broken key', async () => {
    await expect(run({ lake: { ...lake, datalakeTag: undefined } })).resolves.toEqual({
      recorded: false,
      reason: 'lake-has-no-memory-principal',
    });
    await expect(run({ lake: { ...lake, createdByUserId: undefined } })).resolves.toEqual({
      recorded: false,
      reason: 'lake-has-no-memory-principal',
    });
    expect(h.createLedgerAppendSession).not.toHaveBeenCalled();
  });

  it('reports the shred fence as a refusal, not a success', async () => {
    // `append` resolves false when the lake's key was destroyed mid-flight. Reporting that as
    // recorded would tell a surface the ruling reached memory when nothing was written.
    h.append.mockResolvedValue(false);

    await expect(run()).resolves.toEqual({ recorded: false, reason: 'shred-fence' });
  });

  it('still writes the belief when embedding is unavailable', async () => {
    // Previews and self-host runs have no embedding key. A vectorless belief is still recallable
    // (the scorer falls back to lexical and flags it off-scale), so losing the vector must not lose
    // the human's decision.
    h.embed.mockResolvedValue(undefined);

    await expect(run()).resolves.toEqual({ recorded: true });
    expect(h.append.mock.calls[0][0].embedding).toBeUndefined();
  });

  it('still writes the belief when the embed call THROWS', async () => {
    h.embed.mockRejectedValue(new Error('embedding provider down'));

    await expect(run()).resolves.toEqual({ recorded: true });
    expect(h.append.mock.calls[0][0].embedding).toBeUndefined();
  });

  it('embeds the same text it stores, so recall scores what the model will read', async () => {
    await run();

    expect(h.embed).toHaveBeenCalledWith(h.append.mock.calls[0][0].summary);
  });
});

describe('composeFindingResolutionFact', () => {
  it("frames the curator's sentence as a human ruling, and names the problem it answers", async () => {
    const fact = composeFindingResolutionFact(
      { kind: 'metric-disagreement' },
      'resolved',
      'Different fiscal years; both are current.'
    );

    expect(fact).toContain('curator');
    expect(fact).toContain('metric-disagreement');
    expect(fact).toContain('Different fiscal years; both are current.');
  });

  it('distinguishes a dismissal from a resolution in the recalled text itself', async () => {
    // Recall injects only the fact string into the turn - `buildLakeMemoryContext` never passes
    // `sources` or any status through - so if the two read identically the model cannot tell "this
    // was fixed" from "there was nothing to fix".
    const resolved = composeFindingResolutionFact({ kind: 'superlative-conflict' }, 'resolved', 'note');
    const dismissed = composeFindingResolutionFact({ kind: 'superlative-conflict' }, 'dismissed', 'note');

    expect(resolved).not.toEqual(dismissed);
    expect(dismissed).toContain('dismissed');
  });

  it('keeps the normalized grouping subject OUT of the prompt text', async () => {
    // `finding.subject` is a key (lowercased, punctuation stripped), not prose. It reads as mangled
    // text in a system block, and it is not what a curator wrote.
    // Passed through a variable so the subject is actually PRESENT on the argument: asserting it is
    // absent from the output of a function that cannot see it would pass no matter what the function
    // did. This way, widening the parameter and interpolating the subject fails here.
    const withSubject = { kind: 'metric-disagreement' as const, subject: 'q3 revenue' };
    const fact = composeFindingResolutionFact(withSubject, 'resolved', 'the note');

    expect(fact).not.toContain('q3 revenue');
  });
});
