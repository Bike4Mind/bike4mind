import { claudeFamilyVersion } from './claudeModelId';
import { ModelBackend } from './models';

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
