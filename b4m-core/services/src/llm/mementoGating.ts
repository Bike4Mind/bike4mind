/**
 * Which memento pipelines are live for one chat completion - resolved from the caller's
 * per-request flag, the deployment admin setting, and the user's V2 opt-in. Within
 * ChatCompletionProcess these gates control BOTH sides of each pipeline: whether
 * MementoFeature is registered at all (injection) and the write flags it forwards on
 * completion (distillation), so a request can never read memory it was told not to use,
 * or write memory from a turn that opted out.
 *
 * The request flag is a TRI-STATE and the distinction is load-bearing (#1319):
 * - `false`  - explicit opt-out. No memory, either version, read or write. This is what
 *              /api/chat resolves for toolMode 'fast'/'smart', what the voice proxy and
 *              Slack senders hard-code, and what the browser sends when the user has no
 *              memory feature enabled. V2 previously ignored it on both sides, which
 *              leaked context across sessions on the same account with no off-switch
 *              below the account level.
 * - `undefined` - no preference expressed. V1 stays off (it requires explicit intent),
 *              V2 rides on the user's account-level opt-in - the browser sends this for
 *              V2-only users so the opt-in keeps working (see sessionsAPICalls).
 * - `true`   - V1 intent. V1 runs when the admin setting also allows it; V2 (if opted
 *              in) runs as well and wins at inject time (MementoFeature picks one).
 *
 * V2 deliberately does NOT consult the EnableMementos admin setting: the V1 setting
 * predates V2 and gates a different pipeline; V2's gate is the per-user experimental
 * opt-in. Only the caller's explicit `false` overrides that opt-in, per request.
 */
export interface MementoGates {
  /** Inject V1 recall and write V1 mementos this turn. */
  v1: boolean;
  /** Inject V2 recall and write V2 beliefs this turn. */
  v2: boolean;
}

export function resolveMementoGates(
  requestEnableMementos: boolean | undefined,
  adminEnabled: boolean,
  v2OptIn: boolean
): MementoGates {
  return {
    v1: requestEnableMementos === true && adminEnabled,
    v2: v2OptIn && requestEnableMementos !== false,
  };
}
