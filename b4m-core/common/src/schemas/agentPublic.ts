import { z } from 'zod';
import { paginatedResponseSchema } from './pagination';

/**
 * Wire schemas for the public `/api/v1/agents` contracts (api-contract/contracts/agents.contract.ts).
 * Deliberately narrower than IAgent: sharing state, credits, personality/identity/visual, memory and
 * tavern state, orchestration internals and voice fields are never published. A field added here can
 * never be removed, so only what an integrator needs to configure an agent is on the wire.
 *
 * Imported directly (never through the schemas barrel) by the contract and OpenAPI layers, so keep
 * this file free of `@bike4mind/*` imports - the CI spec job loads it without building anything.
 */

const TOOL_LIST_NOTE = 'An empty list (or `null`) means the default tool policy applies.';

export const AgentResourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  system_prompt: z.string().nullable().describe("The agent's system prompt. `null` unless the caller owns the agent."),
  preferred_model: z.string().nullable().describe('Model id the agent answers with; `null` uses the default.'),
  temperature: z.number().nullable(),
  max_tokens: z.number().int().nullable(),
  allowed_tools: z.array(z.string()).nullable().describe(`Tools the agent may call. ${TOOL_LIST_NOTE}`),
  denied_tools: z.array(z.string()).nullable().describe(`Tools the agent may never call. ${TOOL_LIST_NOTE}`),
  trigger_words: z.array(z.string()).describe('Mentions (for example `@research`) that invoke the agent in chat.'),
  is_owner: z.boolean().describe('Whether the caller owns the agent, rather than having it shared with them.'),
  created_at: z.string().nullable().describe('ISO 8601 timestamp.'),
  updated_at: z.string().nullable().describe('ISO 8601 timestamp.'),
});
export type AgentResource = z.infer<typeof AgentResourceSchema>;

export const ListAgentsResponseSchema = paginatedResponseSchema(AgentResourceSchema);
export type ListAgentsResponse = z.infer<typeof ListAgentsResponseSchema>;

/**
 * `id` is a plain string on purpose: a malformed id must answer 404 (CONVENTIONS.md status table),
 * and a path-param schema failure would answer 422.
 */
export const AgentIdParamSchema = z.object({
  id: z.string().min(1),
});

// preferred_model is a plain string rather than the model enum so the published spec does not churn
// as models are added and retired; the route checks it against the live model list.
const agentFields = {
  description: z.string(),
  system_prompt: z.string(),
  preferred_model: z.string().min(1).describe('A chat model id. An unknown model is rejected with a 422.'),
  temperature: z.number().min(0).max(2),
  max_tokens: z.number().int().min(1).max(128000),
  allowed_tools: z.array(z.string()).describe(`Tools the agent may call. ${TOOL_LIST_NOTE}`),
  denied_tools: z.array(z.string()).describe(`Tools the agent may never call. ${TOOL_LIST_NOTE}`),
  trigger_words: z.array(z.string()).describe('Mentions (for example `@research`) that invoke the agent in chat.'),
};

/** Strict, so a camelCase field (the SPA route's spelling) is a 422 rather than silently dropped. */
export const CreateAgentRequestSchema = z
  .object({
    name: z.string().min(1),
    description: agentFields.description.optional(),
    system_prompt: agentFields.system_prompt.optional(),
    preferred_model: agentFields.preferred_model.optional(),
    temperature: agentFields.temperature.optional(),
    max_tokens: agentFields.max_tokens.optional(),
    allowed_tools: agentFields.allowed_tools.optional(),
    denied_tools: agentFields.denied_tools.optional(),
    trigger_words: agentFields.trigger_words.optional(),
  })
  .strict();
export type CreateAgentRequest = z.infer<typeof CreateAgentRequestSchema>;

/**
 * Strict for the same reason as the create body. Omitted fields are left unchanged; `null` on
 * preferred_model, temperature or max_tokens clears it back to the default.
 */
export const UpdateAgentRequestSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: agentFields.description.optional(),
    system_prompt: agentFields.system_prompt.optional(),
    preferred_model: agentFields.preferred_model.nullable().optional(),
    temperature: agentFields.temperature.nullable().optional(),
    max_tokens: agentFields.max_tokens.nullable().optional(),
    allowed_tools: agentFields.allowed_tools.optional(),
    denied_tools: agentFields.denied_tools.optional(),
    trigger_words: agentFields.trigger_words.optional(),
  })
  .strict();
export type UpdateAgentRequest = z.infer<typeof UpdateAgentRequestSchema>;
