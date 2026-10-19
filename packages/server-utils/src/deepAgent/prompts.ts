import {
  measureCharterSizeBytes,
  renderActResult,
  renderCharter,
  renderHandoff,
  renderRecentEpisodes,
  summarizeDrives,
  type GroomContext,
  type OrientContext,
  type ReflectContext,
} from '@bike4mind/agents';

/**
 * Production-tuned cognitive prompts for the LLM-backed wake-cycle steps.
 *
 * These are the host's private prompt bodies - the tuned recipe that the
 * open-core framework (`@bike4mind/agents`) deliberately does NOT ship. The
 * open package provides the render helpers used here plus a generic reference
 * set (`buildReference*Prompt`); production swaps in these tuned versions via
 * the `WakeSteps` port (see `LlmWakeSteps`).
 *
 * Pure string functions - unit-testable without an LLM.
 */

// ── Orient ─────────────────────────────────────────────────────────

export function buildOrientPrompt(ctx: OrientContext): string {
  return [
    'You are the policy step of an autonomous agent waking for one work cycle.',
    'Decide the single next action class that best advances the goal given the',
    'agent’s current drives. Drives are motivational pressures, not orders—',
    'use them to break ties, not to override the goal.',
    '',
    renderCharter(ctx.charter),
    '',
    renderHandoff(ctx.handoff),
    '',
    `Current drives: ${summarizeDrives(ctx.drives)}`,
    '',
    'Recent episodes:',
    renderRecentEpisodes(ctx.recentEpisodes),
    '',
    'Return a policy decision: the action class to run (`actionKind`), a short',
    '`rationale`, and `expectedDriveDelta` (a map of drive name to expected change',
    'in [-1,1]) describing how you expect this action to move the drives.',
  ].join('\n');
}

// ── Reflect ────────────────────────────────────────────────────────

export function buildReflectPrompt(ctx: ReflectContext): string {
  return [
    'You are the reflect step of an autonomous agent, closing out one work cycle.',
    'Make meaning of what just happened and propose how memory and drives should',
    'change. Be conservative: enumerate what you did NOT do this cycle as',
    '`scopeLocks` so an independent reviewer can check your work.',
    '',
    renderCharter(ctx.charter),
    '',
    `Policy decision this cycle: [${ctx.policy.actionKind}] ${ctx.policy.rationale}`,
    `Drives at start: ${summarizeDrives(ctx.drives)}`,
    '',
    renderActResult(ctx.act),
    '',
    'Return a reflection object with:',
    '- `reflection`: what happened and what was learned',
    '- `summary`: one paragraph for the next wake’s orient prompt',
    '- `nextIntendedAction`: what to do next wake',
    '- `nextWakeIntervalMs` (optional): suggested sleep before the next wake',
    '- `scopeLocks`: explicit list of what was NOT done this cycle',
    '- `drivesAfter`: the full drive vector after this cycle (each in [0,1])',
    '- `charterDiff`: a narrow audit record (added/removed memory ids, subgoal',
    '  status changes, and a prose `summary`)',
    '- `addedSemanticMemory`: full new memory entries to persist (with fresh ids,',
    '  an `evidenceTier`, and a `confidence` in [0,1])',
    '- `removedSemanticMemoryIds`: ids of memory entries to drop',
    '- `subgoalUpdates`: subgoals to add or update (matched by id)',
    '- `openBlockers`: the current blocker list',
  ].join('\n');
}

// ── Groom ──────────────────────────────────────────────────────────

export function buildGroomPrompt(ctx: GroomContext): string {
  const measured = measureCharterSizeBytes(ctx.charter);
  return [
    'You are the groom step of an autonomous agent. The charter has grown past',
    `its size budget (${measured} bytes used vs ${ctx.charter.sizeBudgetBytes} budget).`,
    'Compact the semantic memory so the charter fits, WITHOUT losing identity or',
    'goal. Merge redundant facts, drop low-value or stale ones, and keep the facts',
    'most likely to be needed again. Curation is the point—be decisive.',
    '',
    renderCharter(ctx.charter),
    '',
    'Recent episodes (context for what still matters):',
    renderRecentEpisodes(ctx.recentEpisodes),
    '',
    'Return the compacted `semanticMemory` (full entries, each with an id,',
    '`evidenceTier`, and `confidence`) and a refined `openQuestions` list.',
  ].join('\n');
}
