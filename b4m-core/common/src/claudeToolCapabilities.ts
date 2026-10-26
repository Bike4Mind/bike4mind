import { claudeFamilyVersion } from './claudeModelId';
import { ModelBackend } from './models';
import type { AdapterFamily } from './types/entities/ModelCatalogTypes';

/**
 * Native Anthropic tool capabilities, by Claude family and version. Allow-lists rather than a
 * version comparison, so an older or not-yet-reviewed id (a preview, a new family) reads false.
 * Sources: the tool search tool and mid-conversation system messages pages of the Claude docs.
 */
const TOOL_SEARCH_VERSIONS: ReadonlySet<string> = new Set([
  'opus-4-5',
  'opus-4-6',
  'opus-4-7',
  'opus-4-8',
  'opus-5',
  'opus-5-5',
  'sonnet-4-5',
  'sonnet-4-6',
  'sonnet-5',
  'sonnet-5-5',
  'haiku-4-5',
  'haiku-5-5',
  'fable-5',
  'fable-5-1',
  'mythos-5',
  'mythos-5-1',
]);

// Keep in sync with NO_FORCED_TOOL_CHOICE_FAMILY in models.ts when a new 5.x ships.
// Sonnet 5 is left out on purpose: it takes no mid-conversation system messages.
const TOOL_CHANGES_VERSIONS: ReadonlySet<string> = new Set([
  'opus-4-8',
  'opus-5',
  'opus-5-5',
  'sonnet-5-5',
  'haiku-5-5',
  'fable-5',
  'fable-5-1',
  'mythos-5',
  'mythos-5-1',
]);

const NO_ASSISTANT_PREFILL_VERSIONS: ReadonlySet<string> = new Set([
  'opus-4-6',
  'opus-4-7',
  'opus-4-8',
  'opus-5',
  'opus-5-5',
  'sonnet-4-6',
  'sonnet-5',
  'sonnet-5-5',
  'haiku-5-5',
  'fable-5',
  'fable-5-1',
  'mythos-5',
  'mythos-5-1',
]);

export type ClaudeToolCapabilityModel = {
  id: string;
  backend: ModelBackend;
};

// The direct API and Bedrock (InvokeModel) both carry these features; any other route to a Claude id does not.
function servedNatively(model: ClaudeToolCapabilityModel, versions: ReadonlySet<string>): boolean {
  if (model.backend !== ModelBackend.Anthropic && model.backend !== ModelBackend.Bedrock) return false;
  const version = claudeFamilyVersion(model.id);
  return version !== null && versions.has(version);
}

/** Whether the model accepts the tool search server tool and `defer_loading` on tool definitions. */
export function supportsToolSearch(model: ClaudeToolCapabilityModel): boolean {
  return servedNatively(model, TOOL_SEARCH_VERSIONS);
}

/** Whether a system-role message can carry `tool_addition` / `tool_removal` blocks. */
export function supportsToolChanges(model: ClaudeToolCapabilityModel): boolean {
  return servedNatively(model, TOOL_CHANGES_VERSIONS);
}

/** Whether the model accepts a final assistant turn for it to continue. */
export function supportsAssistantPrefill(model: Pick<ClaudeToolCapabilityModel, 'id'>): boolean {
  const version = claudeFamilyVersion(model.id);
  return version === null || !NO_ASSISTANT_PREFILL_VERSIONS.has(version);
}

export type CompletionsToolCapabilityModel = ClaudeToolCapabilityModel & {
  adapterFamily?: AdapterFamily;
};

// Mirror getLlmByModel's dispatch: a catalog row routes on adapterFamily first, everything else on backend.
// MUST STAY IN SYNC WITH getLlmByModel (llm-adapters/src/index.ts) and backendForAdapterFamily
// (llm-adapters/src/adapterFamilyDispatch.ts).
function servedByDirectAnthropic(model: CompletionsToolCapabilityModel): boolean {
  return model.adapterFamily ? model.adapterFamily === 'anthropic-messages' : model.backend === ModelBackend.Anthropic;
}

// Both Claude adapters forward defer_loading and server tools and replay server blocks.
function servedByClaudeAdapter(model: CompletionsToolCapabilityModel): boolean {
  if (servedByDirectAnthropic(model)) return true;
  return model.adapterFamily ? model.adapterFamily === 'bedrock-anthropic' : model.backend === ModelBackend.Bedrock;
}

/**
 * supportsToolChanges, narrowed to models whose `/api/ai/v1/completions` adapter keeps the messages in place and sends the beta.
 * Bedrock is left out until mid-conversation tool changes are verified there.
 */
export function completionsSupportsToolChanges(model: CompletionsToolCapabilityModel): boolean {
  return servedByDirectAnthropic(model) && supportsToolChanges(model);
}

/** supportsToolSearch, narrowed to models whose `/api/ai/v1/completions` adapter actually forwards it. */
export function completionsSupportsToolSearch(model: CompletionsToolCapabilityModel): boolean {
  return servedByClaudeAdapter(model) && supportsToolSearch(model);
}
