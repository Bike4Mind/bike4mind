import type { SystemPromptDetail } from '@bike4mind/common';

/**
 * Resolved inputs for the always-on system-prompt floor. Content strings are
 * passed in already-resolved (via getSettingsValue with its built-in fallback)
 * so this stays a pure function of its inputs and the exact same content the
 * assembly sends is what gets measured - no re-derivation, no drift.
 */
export type AlwaysOnFloorInput = {
  /** The effective artifact gate (admin setting AND request flag) - see resolveArtifactsEnabled. */
  artifactEmissionEnabled: boolean;
  /** Resolved ArtifactEmissionPrompt (or its default). */
  artifactEmissionContent: string;
  /** Ollama/local models ship a lean prompt and skip the help-center nudge. */
  isLocalModel: boolean;
  /** Resolved HelpCenterPrompt (or its default). */
  helpCenterContent: string;
  /**
   * Whether each block survived into the payload, which is not the same question as whether it was
   * enabled: the input budget can drop an enabled block to make room for an attachment. Kept separate
   * so the two are reported with the reason that actually applies rather than both as 'disabled'.
   * Omitted means "not known", and an enabled block is then assumed delivered.
   */
  artifactEmissionDelivered?: boolean;
  helpCenterDelivered?: boolean;
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

  // A block that was switched off and one the budget could not fit are both excluded, but for reasons a
  // reader has to be able to tell apart: one is configuration, the other is a context window too small
  // to hold everything the turn asked for.
  const exclusionReason = (enabled: boolean, delivered: boolean) =>
    !enabled ? ('disabled' as const) : delivered ? undefined : ('token_limit' as const);

  const artifactEnabled = input.artifactEmissionEnabled;
  const artifactIncluded = artifactEnabled && (input.artifactEmissionDelivered ?? true);
  const artifactReason = exclusionReason(artifactEnabled, artifactIncluded);
  details.push({
    source: 'admin',
    name: 'artifact_emission',
    tokenCount: artifactIncluded ? await countTokens(input.artifactEmissionContent) : 0,
    wasIncluded: artifactIncluded,
    ...(artifactReason ? { exclusionReason: artifactReason } : {}),
  });

  const helpCenterEnabled = !input.isLocalModel;
  const helpCenterIncluded = helpCenterEnabled && (input.helpCenterDelivered ?? true);
  const helpCenterReason = exclusionReason(helpCenterEnabled, helpCenterIncluded);
  details.push({
    source: 'admin',
    name: 'help_center',
    tokenCount: helpCenterIncluded ? await countTokens(input.helpCenterContent) : 0,
    wasIncluded: helpCenterIncluded,
    ...(helpCenterReason ? { exclusionReason: helpCenterReason } : {}),
  });

  return details;
}
