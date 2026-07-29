import type { SystemPromptDetail } from '@bike4mind/common';

/**
 * Resolved inputs for the always-on system-prompt floor. Content strings are
 * passed in already-resolved (via getSettingsValue with its built-in fallback)
 * so this stays a pure function of its inputs and the exact same content the
 * assembly sends is what gets measured - no re-derivation, no drift.
 */
export type AlwaysOnFloorInput = {
  /** getSettingsValue('EnableArtifacts'); artifact-emission guidance is gated on it. */
  artifactEmissionEnabled: boolean;
  /** Resolved ArtifactEmissionPrompt (or its default). */
  artifactEmissionContent: string;
  /** Ollama/local models ship a lean prompt and skip the help-center nudge. */
  isLocalModel: boolean;
  /** Resolved HelpCenterPrompt (or its default). */
  helpCenterContent: string;
};

/**
 * Itemize the always-on system-prompt blocks billed on every basic chat turn.
 *
 * The artifact-emission and help-center blocks are unconditional for a normal
 * (non-local) turn, yet they were previously folded into the opaque
 * `tokensBySource.systemPrompts` residual - hiding the largest fixed prompt
 * cost from the Context Inspector. Breaking them out gives the per-section
 * composition #810 needs to decide what is safe to trim. Excluded blocks are
 * still emitted (wasIncluded=false, exclusionReason='disabled') so the floor
 * inventory is complete regardless of settings.
 *
 * NOTE: this measures only content WE author. The provider-injected tool-use
 * preamble that Anthropic adds whenever any tool is attached is not visible
 * here; sizing that needs a provider count_tokens probe (tracked separately).
 *
 * @param countTokens counts one system block's content; injected so the caller
 *   supplies the real tokenizer and tests can stay deterministic.
 */
export async function buildAlwaysOnFloorDetails(
  input: AlwaysOnFloorInput,
  countTokens: (content: string) => Promise<number>
): Promise<SystemPromptDetail[]> {
  const details: SystemPromptDetail[] = [];

  const artifactIncluded = input.artifactEmissionEnabled;
  details.push({
    source: 'admin',
    name: 'artifact_emission',
    tokenCount: artifactIncluded ? await countTokens(input.artifactEmissionContent) : 0,
    wasIncluded: artifactIncluded,
    ...(artifactIncluded ? {} : { exclusionReason: 'disabled' as const }),
  });

  const helpCenterIncluded = !input.isLocalModel;
  details.push({
    source: 'admin',
    name: 'help_center',
    tokenCount: helpCenterIncluded ? await countTokens(input.helpCenterContent) : 0,
    wasIncluded: helpCenterIncluded,
    ...(helpCenterIncluded ? {} : { exclusionReason: 'disabled' as const }),
  });

  return details;
}
