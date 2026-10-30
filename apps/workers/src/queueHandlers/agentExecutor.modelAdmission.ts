import type { ModelAdmission } from '@bike4mind/services/llm/modelAdmission';
import type { ServerAgentDefinition } from '@bike4mind/agents';
import { Logger } from '@bike4mind/observability';
import { resolveDeprecatedModelId } from '@bike4mind/llm-adapters';

const logger = new Logger({ metadata: { component: 'agentExecutor.modelAdmission' } });

/**
 * Keep only the models of a user/org agent definition the caller may run (preferred model first,
 * then its fallbacks, in order). A definition with no admitted model is dropped, so a stored agent
 * cannot be used to reach an entitlement-gated, disabled or unpriced model.
 */
export async function admitAgentDefinitions(
  definitions: ServerAgentDefinition[],
  admission: Pick<ModelAdmission, 'admits'>
): Promise<ServerAgentDefinition[]> {
  const admitted: ServerAgentDefinition[] = [];
  for (const definition of definitions) {
    const models: string[] = [];
    for (const id of [definition.model, ...(definition.fallbackModels ?? [])]) {
      const resolvedModelId = resolveDeprecatedModelId(id, 'agentExecutor.modelAdmission');
      if (await admission.admits(resolvedModelId)) models.push(resolvedModelId);
    }
    if (models.length === 0) {
      logger.warn('agent executor: dropped agent with no admitted model', {
        agent: definition.name,
        model: definition.model,
      });
      continue;
    }
    admitted.push({
      ...definition,
      model: models[0],
      fallbackModels: definition.fallbackModels ? models.slice(1) : undefined,
    });
  }
  return admitted;
}
