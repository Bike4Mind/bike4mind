import { useCallback } from 'react';
import { toast } from 'sonner';
import { useUser } from '@client/app/contexts/UserContext';
import { useSessions } from '@client/app/contexts/SessionsContext';
import { useChatInput } from '@client/app/hooks/useChatInput';
import { useLogEvent } from '@client/app/hooks/data/analytics';
import { fetchPromptById } from '@client/app/hooks/data/briefcase';
import {
  buildPromptContext,
  replacePromptVariables,
  countUnresolvedPlaceholders,
} from '@client/app/utils/briefcase/promptResolution';
import { buildReferenceGuard } from '@client/app/utils/briefcase/referenceGuard';
import { BriefcaseEvents, type IResolvedPromptDispatch } from '@bike4mind/common';

function makeNonce(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * The outcome of a launch, so callers can distinguish "text placed in the input"
 * from "dispatched to send" from "skipped because another launch is in flight" -
 * all three were previously an ambiguous `null`.
 */
export type LaunchResult =
  | { status: 'injected' }
  | { status: 'dispatched'; dispatch: IResolvedPromptDispatch }
  | { status: 'skipped'; reason: 'in-flight' }
  | { status: 'error' };

/**
 * The launcher orchestration boundary. Click flow, in fixed order:
 *   0. acquire the shared single-flight flag (skip if a launch is already pending)
 *   1. authoritative refetch by id (a personal prompt may have changed since the batch)
 *   2. build context + substitute {{variables}}
 *   3. prepend the injection-hardened guard AFTER substitution (when a name exists)
 *   4. branch on executionMode (inject sets input only; auto-fire/hidden dispatch)
 *   5. mint a nonce + publish the dispatch onto the programmaticLaunch channel
 *   6. release the single-flight flag in `finally` (covers success + every throw)
 *
 * Single-flight lives in the shared chat-input store, so it guards across all
 * launcher instances AND drives every launcher's disabled state. The `finally`
 * is the sole release path - no watchdog timer, which previously opened a
 * duplicate-send window when a refetch outlived it.
 *
 * 'hidden' is treated as 'auto-fire' in v1 (no backend hidden-send support yet).
 */
export function useLaunchPrompt() {
  const { currentUser } = useUser();
  const { currentSessionId } = useSessions();
  const setProgrammaticLaunch = useChatInput(s => s.setProgrammaticLaunch);
  const setChatInputValue = useChatInput(s => s.setChatInputValue);
  const isLaunching = useChatInput(s => s.briefcaseLaunchInFlight);
  const logEvent = useLogEvent();

  const launch = useCallback(
    async (promptId: string): Promise<LaunchResult> => {
      const store = useChatInput.getState();
      if (store.briefcaseLaunchInFlight) return { status: 'skipped', reason: 'in-flight' };
      store.setBriefcaseLaunchInFlight(true);

      try {
        // 1. Authoritative refetch - its mode/tools/content win over any cached copy.
        const prompt = await fetchPromptById(promptId);

        // 2. Build context + substitute.
        const context = buildPromptContext(
          {
            name: currentUser?.name,
            email: currentUser?.email ?? undefined,
            role: currentUser?.level,
          },
          null // no clean org/entity NAME available in this host yet (best-effort guard)
        );
        let content = replacePromptVariables(prompt.promptText, context);

        const unresolved = countUnresolvedPlaceholders(content);
        if (unresolved > 0) {
          logEvent.mutate({
            type: BriefcaseEvents.RESOLUTION_FAILED,
            metadata: { promptId, unresolvedPlaceholderCount: unresolved },
          });
        }

        // 3. Prepend the guard AFTER substitution, when a context name is available.
        if (context.organization) {
          const { guard, triggered } = buildReferenceGuard(context.organization);
          if (triggered) {
            logEvent.mutate({ type: BriefcaseEvents.GUARD_TRIGGERED, metadata: { promptId, kind: triggered } });
          }
          if (guard) content = `${guard}\n\n${content}`;
        }

        logEvent.mutate({
          type: BriefcaseEvents.PROMPT_SELECTED,
          metadata: {
            promptId,
            ownership: prompt.userId ? 'personal' : 'system',
            executionMode: prompt.executionMode ?? 'inject',
          },
        });

        // 4. Branch on execution mode.
        const mode = prompt.executionMode ?? 'inject';
        if (mode === 'inject') {
          setChatInputValue(content); // place in input; user edits/sends — NO dispatch
          return { status: 'injected' };
        }

        // auto-fire (and hidden, treated as auto-fire in v1): reflect in input, then dispatch.
        setChatInputValue(content);
        const dispatch: IResolvedPromptDispatch = {
          promptId,
          dispatchNonce: makeNonce(),
          promptContent: content,
          promptName: prompt.name,
          isHidden: false,
          requiredTools: prompt.requiredTools ?? null,
          sessionId: currentSessionId ?? null,
        };
        setProgrammaticLaunch(dispatch);
        return { status: 'dispatched', dispatch };
      } catch (err) {
        // Refetch can 404 (deleted), 403 (flag toggled mid-session), or fail on the
        // network. Surface it instead of letting the button silently spin-release.
        console.error('Briefcase launch failed:', err);
        toast.error("Couldn't open that prompt. Please try again.");
        return { status: 'error' };
      } finally {
        useChatInput.getState().setBriefcaseLaunchInFlight(false);
      }
    },
    [currentUser, currentSessionId, setProgrammaticLaunch, setChatInputValue, logEvent]
  );

  return { launch, isLaunching };
}
