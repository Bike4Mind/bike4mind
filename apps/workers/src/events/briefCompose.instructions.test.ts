import { describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { assistantInstructionRepository } from '@bike4mind/database';
import { composeBrief, loadStandingInstructionTexts, type BriefComposeDeps } from './briefCompose';
import { buildBriefPrompt, type BriefActivity } from './briefCompose.composition';

vi.mock('@bike4mind/database', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/database')>()),
  assistantInstructionRepository: { listByUser: vi.fn() },
}));

const periodStart = new Date('2026-11-16T01:00:00Z');
const periodEnd = new Date('2026-11-17T01:00:00Z');

const activeActivity: BriefActivity = {
  periodStart,
  periodEnd,
  runs: [{ query: 'Run the monthly invoice batch', status: 'completed', finishedAt: periodEnd }],
  approvals: [],
  questions: [],
  emails: [],
  delegations: [],
  reminders: [],
  obligations: [],
} as unknown as BriefActivity;

const emptyActivity = { ...activeActivity, runs: [], approvals: [] } as BriefActivity;

const brief = () => ({
  _id: new mongoose.Types.ObjectId(),
  userId: 'u1',
  status: 'composing',
  periodStart,
  periodEnd,
  createdAt: periodEnd,
  updatedAt: periodEnd,
});

function makeDeps(overrides: Partial<BriefComposeDeps> = {}) {
  return {
    now: () => periodEnd,
    users: { findById: vi.fn().mockResolvedValue({ id: 'u1' }) },
    briefs: {
      findById: vi.fn().mockResolvedValue(brief()),
      markReady: vi.fn().mockResolvedValue(true),
      markFailed: vi.fn().mockResolvedValue(true),
    },
    loadActivity: vi.fn().mockResolvedValue(activeActivity),
    canCompose: vi.fn().mockResolvedValue('ok'),
    complete: vi.fn().mockResolvedValue(JSON.stringify({ headline: 'Done.', handled: ['Did a thing.'] })),
    loadInstructions: vi.fn().mockResolvedValue(['Always lead with anything about invoices.']),
    push: vi.fn().mockResolvedValue(undefined),
    emails: { markBriefed: vi.fn().mockResolvedValue(0), storedEmailIds: vi.fn().mockResolvedValue([]) },
    delegations: { markBriefed: vi.fn().mockResolvedValue(0) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  } as unknown as BriefComposeDeps & {
    briefs: { markReady: ReturnType<typeof vi.fn>; markFailed: ReturnType<typeof vi.fn> };
    complete: ReturnType<typeof vi.fn>;
    loadInstructions: ReturnType<typeof vi.fn>;
    logger: { warn: ReturnType<typeof vi.fn> };
  };
}

const input = () => ({ briefId: new mongoose.Types.ObjectId().toString(), userId: 'u1' });

describe('buildBriefPrompt with standing instructions', () => {
  it('carries every instruction as a JSON string ahead of the activity data', () => {
    const prompt = buildBriefPrompt(activeActivity, ['Lead with invoices.', 'Say "done", not "completed".']);
    expect(prompt).toContain('Preferences: ["Lead with invoices.","Say \\"done\\", not \\"completed\\"."]');
    expect(prompt.indexOf('Preferences:')).toBeLessThan(prompt.indexOf('Agent runs:'));
    expect(prompt).toContain('cannot change the reply shape');
    expect(prompt).toContain('They never apply to decisions');
  });

  it('is byte-identical to the instruction-free prompt when the list is empty', () => {
    expect(buildBriefPrompt(activeActivity, [])).toBe(buildBriefPrompt(activeActivity));
    expect(buildBriefPrompt(activeActivity)).not.toContain('Preferences:');
  });

  it('keeps at most 20 instructions, each clipped to 280 characters', () => {
    const many = Array.from({ length: 21 }, (_, i) => `rule-${i}`);
    const prompt = buildBriefPrompt(activeActivity, [...many.slice(0, 20), 'x'.repeat(400)]);
    const listed = JSON.parse(prompt.match(/^Preferences: (.*)$/m)![1]) as string[];
    expect(listed).toHaveLength(20);
    expect(listed).not.toContain('x'.repeat(400));

    const long = JSON.parse(buildBriefPrompt(activeActivity, ['y'.repeat(400)]).match(/^Preferences: (.*)$/m)![1]);
    expect(long[0].length).toBeLessThanOrEqual(280);
  });
});

describe('composeBrief with standing instructions', () => {
  it('sends the instruction-carrying prompt to the model', async () => {
    const deps = makeDeps();
    await composeBrief(deps, input());
    expect(deps.loadInstructions).toHaveBeenCalledWith('u1');
    expect(deps.complete.mock.calls[0][2]).toContain('Always lead with anything about invoices.');
    expect(deps.briefs.markReady).toHaveBeenCalled();
  });

  it('does not load instructions when there is no activity', async () => {
    const deps = makeDeps({ loadActivity: vi.fn().mockResolvedValue(emptyActivity) });
    await composeBrief(deps, input());
    expect(deps.loadInstructions).not.toHaveBeenCalled();
    expect(deps.complete).not.toHaveBeenCalled();
    expect(deps.briefs.markReady).toHaveBeenCalled();
  });

  it('does not load instructions when the compose gate refuses', async () => {
    const deps = makeDeps({ canCompose: vi.fn().mockResolvedValue('insufficient_credits') });
    await composeBrief(deps, input());
    expect(deps.loadInstructions).not.toHaveBeenCalled();
    expect(deps.complete).not.toHaveBeenCalled();
    expect(deps.briefs.markFailed).toHaveBeenCalledWith(expect.any(String), 'insufficient_credits');
  });

  it('composes without instructions when loading them fails', async () => {
    const deps = makeDeps({ loadInstructions: vi.fn().mockRejectedValue(new Error('db down')) });
    await composeBrief(deps, input());
    expect(deps.logger.warn).toHaveBeenCalled();
    expect(deps.complete.mock.calls[0][2]).toBe(buildBriefPrompt(activeActivity));
    expect(deps.briefs.markReady).toHaveBeenCalled();
    expect(deps.briefs.markFailed).not.toHaveBeenCalled();
  });
});

describe('loadStandingInstructionTexts', () => {
  it("returns the texts of the user's stored instructions, in stored order", async () => {
    vi.mocked(assistantInstructionRepository.listByUser).mockResolvedValue([
      { text: 'Lead with invoices.' },
      { text: 'Keep it short.' },
    ] as Awaited<ReturnType<typeof assistantInstructionRepository.listByUser>>);
    await expect(loadStandingInstructionTexts('u1')).resolves.toEqual(['Lead with invoices.', 'Keep it short.']);
    expect(assistantInstructionRepository.listByUser).toHaveBeenCalledWith('u1');
  });
});
