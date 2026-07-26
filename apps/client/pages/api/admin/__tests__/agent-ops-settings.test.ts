import { describe, it, expect } from 'vitest';
import { AgentOpsLlmModel } from '@bike4mind/database';
import { DEPRECATED_MODEL_MAP } from '@bike4mind/llm-adapters';
import { AGENT_OPS_VALID_MODELS } from '../agent-ops-settings';
import { LLM_MODELS } from '@client/app/components/admin/AgentOpsTab';

/**
 * Agent-ops keeps a curated model list rather than reading the catalog, so it is maintained by
 * hand in four places: this endpoint's allowlist, the AgentOpsTab picker, the
 * IAgentOpsSettings.generationLlmModel union, and the AgentOpsLlmModel Mongoose enum. Nothing
 * failed when they disagreed, and they did:
 *
 *   - the picker offered `claude-opus-5` as its recommended default while the endpoint's
 *     allowlist omitted it, so choosing it returned 400 "Invalid LLM model specified";
 *   - both still offered `grok-3` (labelled "xAI Latest") months after Grok 4.5 superseded it.
 *
 * These tests pin the lists to each other so the next divergence fails here instead of in an
 * admin's face.
 */
describe('agent-ops model list consistency', () => {
  const pickerValues = LLM_MODELS.map(m => m.value);

  it('offers exactly the models the endpoint accepts', () => {
    // Compared as sorted arrays so the message names the specific offender on failure.
    expect([...pickerValues].sort()).toEqual([...AGENT_OPS_VALID_MODELS].sort());
  });

  it('offers no model the endpoint would reject with a 400', () => {
    const rejected = pickerValues.filter(v => !AGENT_OPS_VALID_MODELS.includes(v));
    expect(rejected, `picker offers models the API rejects: ${rejected.join(', ')}`).toEqual([]);
  });

  it('accepts only values the Mongoose enum can persist', () => {
    const persistable = new Set<string>(Object.values(AgentOpsLlmModel));
    const unpersistable = AGENT_OPS_VALID_MODELS.filter(v => !persistable.has(v));
    expect(
      unpersistable,
      `allowlist entries absent from AgentOpsLlmModel (would fail Mongoose validation): ${unpersistable.join(', ')}`
    ).toEqual([]);
  });

  it('never lets an admin newly pin a deprecated model', () => {
    // A save is a new write, so there is no backward-compat reason to accept a retired ID here.
    // Existing documents keep working through resolveDeprecatedModelId.
    const deprecated = AGENT_OPS_VALID_MODELS.filter(v => v in DEPRECATED_MODEL_MAP);
    expect(deprecated, `selectable models that resolveDeprecatedModelId would remap: ${deprecated.join(', ')}`).toEqual(
      []
    );
  });

  it('keeps deprecated values in the Mongoose enum so existing documents still validate', () => {
    // Removing one of these would break reads of settings docs already pinned to it.
    const persistable = new Set<string>(Object.values(AgentOpsLlmModel));
    expect(persistable.has('grok-3')).toBe(true);
    expect(persistable.has('claude-sonnet-4-20250514')).toBe(true);
  });

  it('has no duplicate entries in either list', () => {
    expect(new Set(pickerValues).size).toBe(pickerValues.length);
    expect(new Set(AGENT_OPS_VALID_MODELS).size).toBe(AGENT_OPS_VALID_MODELS.length);
  });
});
