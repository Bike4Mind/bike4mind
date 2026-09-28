import { RESEARCH_RELEVANCE_MODEL_DEFAULT, type ModelInfo } from '@bike4mind/common';
import { agentOpsModelLabels, agentOpsModelOptions } from './agentOpsModels';

/** One selectable relevance-judge model: the id to save and the label to show for it. */
export type ResearchModelOption = {
  id: string;
  label: string;
};

/**
 * Text models built for a job other than answering a short prompt: agentic research, computer use,
 * coding, multi-agent orchestration. The judge reads a title and a snippet and returns one number,
 * so these are slow or expensive at best and fail outright at worst. The catalog carries no flag
 * for them (many arrive through live discovery), so they are matched on id and name tokens.
 */
const SPECIALTY_MODEL_TOKEN =
  /(?:^|[-_.:/\s])(?:deep-research|computer-use|multi-agent|grok-build|code)(?:[-_.:/\s]|$)/i;

const isSpecialtyModel = (model: ModelInfo): boolean =>
  SPECIALTY_MODEL_TOKEN.test(model.id) || SPECIALTY_MODEL_TOKEN.test(model.name.replace(/\s+/g, '-'));

/**
 * The relevance-judge picker's options, best-first, with names shared across backends
 * disambiguated. Disabled models are dropped: unlike the agent-ops picker there is no admin here
 * who needs to see why one is missing, and a run on one would fail at the first judgment.
 */
export function researchJudgeModelOptions(models: ModelInfo[]): ResearchModelOption[] {
  const eligible = agentOpsModelOptions(models).filter(model => !model.disabled && !isSpecialtyModel(model));
  const labels = agentOpsModelLabels(eligible);
  return eligible.map(model => ({ id: model.id, label: labels.get(model.id) ?? model.name }));
}

/**
 * What "Default" resolves to, named, so a manager can tell what they get by leaving it unset.
 * Must stay in step with the run's own fallback (`RELEVANCE_JUDGE_DEFAULT_MODEL`), which reads the
 * same shared constant.
 */
export function researchDefaultModelLabel(models: ModelInfo[]): string {
  const defaultModel = models.find(model => model.id === RESEARCH_RELEVANCE_MODEL_DEFAULT);
  return defaultModel ? `Default (${defaultModel.name})` : 'Default';
}
