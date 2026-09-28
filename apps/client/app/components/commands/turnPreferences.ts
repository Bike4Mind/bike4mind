import type { LLMContextProps } from '@client/app/contexts/LLMContext';
import type { LLMCommandArgs } from './LLMCommand';

/**
 * Composer preferences that every send path must forward, not only the composer's own
 * (useSendMessage). Secondary paths (QuestMasterReply's subtask actions, the SessionMiddle
 * edit/retry resend) read them with `useLLM(useShallow(selectTurnPreferences))` and spread
 * the result into their handler args.
 *
 * `agentMode` is deliberately absent: it records how useSendMessage's routeQuery step
 * routed a composer turn, and secondary sends never pass through that routing, so
 * forwarding the raw toggle would misattribute them in telemetry.
 */
export type TurnPreferences = Pick<LLMCommandArgs, 'researchMode' | 'skipAutoOffers'>;

export const selectTurnPreferences = (state: LLMContextProps): TurnPreferences => ({
  researchMode: state.researchMode,
  skipAutoOffers: state.skipAutoOffers,
});
