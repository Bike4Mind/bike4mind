import type { SystemPromptDetail } from '@bike4mind/common';
import type { BuilderInjectedBlock, BuilderInjectedBlockId } from '@bike4mind/utils';

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
 * here; sizing that needs a provider count_tokens probe - see
 * packages/scripts/count-tokens-probe.ts.
 *
 * DECISION (#810, real cl100k_base counts, not estimates): against a ~7,400-7,800
 * token cold-turn target, artifact_emission is ~2,822 tokens (~38%) and help_center
 * ~178 (~2%). The two BuilderInjectedBlock rows below are far smaller - format_prompt
 * ~66 tokens, image_prompt ~38, combined ~1.4% of the target. format_prompt and
 * image_prompt are kept AS-IS: format_prompt's
 * gate (UseFormatPrompt) defaults OFF, so it already contributes 0 tokens on a
 * default deployment; image_prompt is already double-gated (imageGenerationAvailable
 * AND a word-boundary trigger pattern, both already narrowed and tested) and its
 * remaining cost is a rounding error against the target. Trimming either buys
 * nothing measurable. artifact_emission is the real lever (~38%) but is explicitly
 * OUT OF SCOPE here - the issue notes a prior attempt to trim it was declined
 * pending product sign-off, and this ticket's guardrail (measure before removing)
 * argues for a dedicated follow-on with usage data, not a blind cut riding on this
 * PR. Revisit format_prompt specifically if production data ever shows
 * UseFormatPrompt on at meaningful volume - that would make its ~66 tokens/turn
 * worth a trigger-word gate symmetric with image_prompt's.
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

/**
 * Which source/name each injected block reports as, for the Context Inspector join. Exported so
 * systemPromptDisclosure's text-side row for the same two blocks uses the identical source/name -
 * a second copy of this table would let the breakdown and the disclosure disagree.
 */
export const INJECTED_BLOCK_METADATA: Record<
  BuilderInjectedBlockId,
  { source: SystemPromptDetail['source']; name: string }
> = {
  // FormatPromptTemplate is an admin-editable setting; the image nudge's wording is hardcoded and only
  // its on/off condition (UseImagePrompt, IMAGE_REQUEST_PATTERN, imageGenerationAvailable) is settings-driven.
  formatPrompt: { source: 'admin', name: 'format_prompt' },
  imagePrompt: { source: 'hardcoded', name: 'image_prompt' },
};

/**
 * Itemize the two always-on blocks `buildAndSortMessages` injects itself (see BuilderInjectedBlock),
 * downstream of where the caller assembles its own systemPromptDetails - closing the gap where their
 * real, billed tokens previously landed in the opaque `tokensBySource` residual instead of a named row.
 *
 * Mirrors buildAlwaysOnFloorDetails: iterates the fixed id list rather than the input array, so a
 * caller passing an empty/incomplete `blocks` array still gets a complete two-row inventory, and never
 * counts tokens for a row that was not delivered.
 */
export async function buildInjectedBlockDetails(
  blocks: readonly BuilderInjectedBlock[],
  countTokens: (content: string) => Promise<number>
): Promise<SystemPromptDetail[]> {
  const details: SystemPromptDetail[] = [];

  for (const id of ['formatPrompt', 'imagePrompt'] as const) {
    const block = blocks.find(b => b.id === id);
    const metadata = INJECTED_BLOCK_METADATA[id];
    const wasIncluded = (block?.injected ?? false) && (block?.delivered ?? false);
    const exclusionReason = !block?.injected
      ? ('disabled' as const)
      : wasIncluded
        ? undefined
        : ('token_limit' as const);
    details.push({
      source: metadata.source,
      name: metadata.name,
      tokenCount: wasIncluded && block?.content ? await countTokens(block.content) : 0,
      wasIncluded,
      ...(exclusionReason ? { exclusionReason } : {}),
    });
  }

  return details;
}
