import type { ILoop } from '@bike4mind/common';

type LoopConfig = Pick<
  ILoop,
  | 'stages'
  | 'stageConfig'
  | 'model'
  | 'budgetCreditsPerDay'
  | 'maxConcurrent'
  | 'tools'
  | 'triageModel'
  | 'escalationModel'
>;

const SUMMARY_MAX = 500;

const show = (value: unknown): string =>
  value === undefined || value === null || value === '' ? 'none' : String(value);

/**
 * A short ASCII summary of what an owner edit changed in the fields the loop stats mark as eras, e.g.
 * `stage "review" added; budget 200 -> 300`. Empty when none of them changed. Logged as a `config_changed` event.
 */
export function loopConfigChangeSummary(before: LoopConfig, after: LoopConfig): string {
  const parts: string[] = [];

  const removed = before.stages.filter(stage => !after.stages.includes(stage));
  const added = after.stages.filter(stage => !before.stages.includes(stage));
  for (const stage of removed) parts.push(`stage "${stage}" removed`);
  for (const stage of added) parts.push(`stage "${stage}" added`);
  if (removed.length === 0 && added.length === 0 && before.stages.join('\n') !== after.stages.join('\n')) {
    parts.push('stages reordered');
  }

  const configOf = (loop: LoopConfig) => new Map((loop.stageConfig ?? []).map(entry => [entry.stage, entry]));
  const [beforeConfig, afterConfig] = [configOf(before), configOf(after)];
  for (const stage of after.stages.filter(stage => before.stages.includes(stage))) {
    if (JSON.stringify(beforeConfig.get(stage) ?? {}) !== JSON.stringify(afterConfig.get(stage) ?? {})) {
      parts.push(`stage config changed for "${stage}"`);
    }
  }

  const scalar = (label: string, from: unknown, to: unknown) => {
    if (show(from) !== show(to)) parts.push(`${label} ${show(from)} -> ${show(to)}`);
  };
  scalar('model', before.model, after.model);
  scalar('budget', before.budgetCreditsPerDay, after.budgetCreditsPerDay);
  scalar('lanes', before.maxConcurrent ?? 1, after.maxConcurrent ?? 1);
  scalar('triage model', before.triageModel, after.triageModel);
  scalar('escalation model', before.escalationModel, after.escalationModel);

  const toolsAdded = after.tools.filter(tool => !before.tools.includes(tool)).map(tool => `+${tool}`);
  const toolsRemoved = before.tools.filter(tool => !after.tools.includes(tool)).map(tool => `-${tool}`);
  if (toolsAdded.length + toolsRemoved.length > 0) parts.push(`tools ${[...toolsAdded, ...toolsRemoved].join(' ')}`);

  // Owner text (stage and model names) may hold anything; the event reason stays ASCII.
  return parts
    .join('; ')
    .replace(/[^\x20-\x7e]/g, '?')
    .slice(0, SUMMARY_MAX);
}
