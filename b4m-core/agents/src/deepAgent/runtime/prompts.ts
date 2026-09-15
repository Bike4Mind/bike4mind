import { type Charter, type Episode, type Handoff } from '../schemas';
import type { ActContext, ActResult } from './types';

/**
 * Framework-level prompt building blocks for the wake cycle.
 *
 * This module ships the *rendering* helpers (charter / episodes / handoff / act
 * result -> prompt text) and the *act-step* prompts (system prompt + query).
 * These are generic, reusable framing - pure string functions, unit-testable
 * without an LLM.
 *
 * The production-tuned *cognitive* prompts (orient / reflect / groom) are NOT
 * here: they live behind a swappable `WakeSteps` impl in the host application.
 * A host's tuned prompts compose these render helpers; the open package ships a
 * reference set (see `referenceWakeSteps`) to keep the loop runnable.
 */

const MAX_FACT_PREVIEW = 12;
const MAX_EPISODE_PREVIEW = 5;

/** Compact, stable rendering of the charter's identity + goal + standing state. */
export function renderCharter(charter: Charter): string {
  const subgoals = charter.subgoals.length
    ? charter.subgoals.map(s => `  - [${s.status}] (${s.targetTier}, p${s.priority}) ${s.description}`).join('\n')
    : '  (none)';
  const memory = charter.semanticMemory.length
    ? charter.semanticMemory
        .slice(0, MAX_FACT_PREVIEW)
        .map(m => `  - (${m.evidenceTier}, conf ${m.confidence}) ${m.fact}`)
        .join('\n')
    : '  (none)';

  return [
    `Agent: ${charter.identity.name} (${charter.identity.role})`,
    `Operating tier: ${charter.currentTier}`,
    `Goal: ${charter.goal.description}`,
    charter.goal.successCriteria.length
      ? `Success criteria:\n${charter.goal.successCriteria.map(c => `  - ${c}`).join('\n')}`
      : 'Success criteria: (none stated)',
    `Subgoals:\n${subgoals}`,
    `Semantic memory (groomed facts):\n${memory}`,
    charter.openQuestions.length
      ? `Open questions:\n${charter.openQuestions.map(q => `  - ${q}`).join('\n')}`
      : 'Open questions: (none)',
    charter.blockers.length ? `Blockers:\n${charter.blockers.map(b => `  - ${b}`).join('\n')}` : 'Blockers: (none)',
  ].join('\n');
}

/** One line per recent episode - the tail of episodic memory. */
export function renderRecentEpisodes(episodes: Episode[]): string {
  if (!episodes.length) return '(no prior episodes — this is an early wake)';
  return episodes
    .slice(0, MAX_EPISODE_PREVIEW)
    .map(e => {
      const locks = e.scopeLocks.length ? ` | scope-locks: ${e.scopeLocks.join('; ')}` : '';
      return `- ${e.wakeAt} [${e.policyDecision.actionKind}] ${e.reflection}${locks}`;
    })
    .join('\n');
}

/** The prior wake's handoff, rendered for the orient prompt. */
export function renderHandoff(handoff: Handoff | null): string {
  if (!handoff) return 'Handoff: (first wake — no prior handoff)';
  return [
    `Last wake (#${handoff.wakeCount}): ${handoff.lastActionSummary || '(no summary)'}`,
    `Intended next action: ${handoff.nextIntendedAction || '(none recorded)'}`,
  ].join('\n');
}

// Tool output (web_search, deep_research) can be huge - bound it so the reflect
// prompt stays small enough for the model to return well-formed JSON.
const MAX_OBSERVATIONS = 12;
const MAX_OBSERVATION_CHARS = 800;

/** Render an act step's actions + observations for the reflect prompt. */
export function renderActResult(act: ActResult): string {
  const actions = act.actionsTaken.length
    ? act.actionsTaken.map(a => `  - ${a.tool} → ${a.succeeded ? 'ok' : 'FAILED'}`).join('\n')
    : '  (no tool calls)';
  const shown = act.observations.slice(0, MAX_OBSERVATIONS);
  const obsLines = shown.map(o => {
    const summary =
      o.summary.length > MAX_OBSERVATION_CHARS ? `${o.summary.slice(0, MAX_OBSERVATION_CHARS)}…[truncated]` : o.summary;
    return `  - [${o.kind}] ${summary}`;
  });
  if (act.observations.length > MAX_OBSERVATIONS) {
    obsLines.push(`  - …and ${act.observations.length - MAX_OBSERVATIONS} more observation(s)`);
  }
  const obs = obsLines.length ? obsLines.join('\n') : '  (no observations)';
  return `Actions taken:\n${actions}\nObservations:\n${obs}`;
}

// ── Act ────────────────────────────────────────────────────────────

/** System prompt for the act step's ReActAgent - frames who it is and the bar. */
export function buildActSystemPrompt(ctx: ActContext, persona?: string): string {
  return [
    // Mission linkage: when this charter belongs to a host agent, the agent's
    // own system prompt leads - the mission framing wraps the persona, not the
    // other way around.
    ...(persona ? [persona, ''] : []),
    `You are ${ctx.charter.identity.name}, a ${ctx.charter.identity.role} agent operating`,
    `at the ${ctx.charter.currentTier} evidence tier.`,
    `Your goal: ${ctx.charter.goal.description}`,
    '',
    'Use your tools to make concrete progress this cycle. Do real work, not',
    'speculation. If you lack a tool for the chosen action, say so plainly and do',
    'the most useful thing you can. Keep claims honest about what was actually',
    'verified versus merely attempted.',
  ].join('\n');
}

/** The query that drives one act step - the policy's chosen action, in context. */
export function buildActQuery(ctx: ActContext): string {
  return [
    `Chosen action this cycle: [${ctx.policy.actionKind}] ${ctx.policy.rationale}`,
    '',
    'Execute that action now using your available tools. When done, briefly report',
    'what you did and what you observed.',
  ].join('\n');
}
