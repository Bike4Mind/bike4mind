import { useCallback } from 'react';
import { toast } from 'sonner';
import { useShallow } from 'zustand/react/shallow';

import { B4MLLMTools, BRIEFCASE_DISALLOWED_TOOLS } from '@bike4mind/common';
import { useLLM } from '@client/app/contexts/LLMContext';
import type { LLMSettings } from '@client/app/components/commands/LLMCommand';
import { recommendTools, mergeTools } from '@client/app/utils/toolRecommender';

export interface AssembleSettingsParams {
  /** Whether the send streams chunks (forwarded straight into the payload). */
  stream: boolean;
  /** Output-token ceiling already clamped by `useTokenLimits`. */
  safeMaxTokens: number;
}

export interface ResolveToolsParams {
  /** Raw prompt text - drives Smart-mode tool recommendations. */
  prompt: string;
  /** Whether the current model can run tools (`currentModelInfo?.supportsTools`). */
  supportsTools: boolean;
  /** Per-message briefcase tools override (one-click prompts). */
  toolsOverride?: B4MLLMTools[];
}

export interface ResolveToolsResult {
  /** The tool list to dispatch with this send. */
  effectiveTools: B4MLLMTools[];
  /**
   * True when a briefcase `toolsOverride` requires tools the current model can't
   * run. The structured refusal toast has already fired; the caller MUST abort the
   * send - never silently degrade to a tool-less send (reads as an LLM regression).
   */
  refused: boolean;
}

/**
 * Owns assembly of the per-send LLM request shape, extracted from `useSendMessage`:
 *  - `assembleSettings` builds the `LLMSettings` sampling payload from the LLM store.
 *  - `resolveTools` runs the tool-resolution ladder (model-capability gate -> Smart
 *    recommendations -> Fast -> briefcase per-message override), emitting the Smart-tools
 *    info toast and the structured tool-refusal error toast exactly as the inline logic did.
 *
 * Image settings, the vision warning, and the legacy top-level image-param passthrough
 * intentionally stay in `useSendMessage`: their raw params are reused across the
 * command / LLM / agent-executor dispatch paths, so moving them here would not decouple them.
 */
export function useLLMSettingsAssembly(): {
  assembleSettings: (params: AssembleSettingsParams) => LLMSettings;
  resolveTools: (params: ResolveToolsParams) => ResolveToolsResult;
} {
  const [temperature, top_p, n, toolMode, tools] = useLLM(
    useShallow(s => [s.temperature, s.top_p, s.n, s.toolMode, s.tools])
  );

  const assembleSettings = useCallback(
    ({ stream, safeMaxTokens }: AssembleSettingsParams): LLMSettings => ({
      temperature: temperature ?? 0.9,
      top_p: top_p ?? 1,
      n: n ?? 1,
      stream,
      stop: null,
      max_tokens: safeMaxTokens,
      presence_penalty: 0,
      frequency_penalty: 0,
      logit_bias: {},
    }),
    [temperature, top_p, n]
  );

  const resolveTools = useCallback(
    ({ prompt, supportsTools, toolsOverride }: ResolveToolsParams): ResolveToolsResult => {
      // Briefcase per-message tools override: a one-click prompt declares exactly
      // the tools its send must run with, for THIS message only - without mutating
      // the user's sticky tool selection. It short-circuits the Smart/Fast ladder
      // entirely, so we neither run recommendations nor surface a "Smart tools" toast
      // for tools the override would only replace. If the current model can't run
      // tools, the send is REFUSED with a structured message (never silently degraded
      // to a tool-less send, which reads as an LLM regression - see the briefcase blueprint).
      if (toolsOverride && toolsOverride.length > 0) {
        // Defense-in-depth: re-strip integration-gated tools at dispatch. The
        // authoring API already rejects them, but a seeded/DB-written system prompt
        // could carry one - never let it ride into a send via the override.
        const safeOverride = toolsOverride.filter(t => !(BRIEFCASE_DISALLOWED_TOOLS as readonly string[]).includes(t));
        if (!supportsTools) {
          // Omit the parenthetical when stripping left no runnable tools, so the
          // message never degrades to "requires tools () that the current model can't run".
          const toolList = safeOverride.length > 0 ? ` (${safeOverride.join(', ')})` : '';
          toast.error(
            `This prompt requires tools${toolList} that the current model can't run. Switch to a tool-capable model and try again.`
          );
          return { effectiveTools: [], refused: true };
        }
        return { effectiveTools: safeOverride, refused: false };
      }

      // Standard tool-resolution ladder (no per-message override).
      if (!supportsTools) {
        // Model doesn't support tools (e.g. image generation models) - skip recommendations
        return { effectiveTools: [], refused: false };
      }
      if (toolMode === 'smart') {
        const recommendations = recommendTools(prompt);
        const autoSelected = recommendations.filter(r => !tools.includes(r.tool));
        if (autoSelected.length > 0) {
          const names = autoSelected.map(r => r.reason).join(', ');
          toast.info(`Smart tools: ${names}`);
        }
        return { effectiveTools: mergeTools(recommendations, tools), refused: false };
      }
      if (toolMode === 'fast') {
        return { effectiveTools: [], refused: false };
      }
      return { effectiveTools: tools, refused: false };
    },
    [tools, toolMode]
  );

  return { assembleSettings, resolveTools };
}
