import { DIRECTOR_TOOLS, buildDirectorSystemContext } from '@bike4mind/common';

/**
 * A notebook the Studio Direct button started (`session.productionCompositionId`, written by startAgentExecution
 * after its access and ownership checks) runs every turn as the director: the director tools join the run's
 * toolbelt, and the director context joins the system message. The client forces such turns into agent mode
 * (useSendMessage); this is the executor's half. Kept pure so it is testable without agentExecutor's graph.
 *
 * The tools are only added to the names; buildAgentProductionToolConfig still decides whether they are offered (the
 * Productions flag and audience, not an API-key run), and applySessionToolPolicy still applies the session's and the
 * profile's denials after this.
 */

type DirectedSessionInput = {
  productionCompositionId?: string;
  /** Set when an API key started the run; such runs never direct. */
  apiKeyId?: string;
};

const directedCompositionId = ({ productionCompositionId, apiKeyId }: DirectedSessionInput): string | undefined =>
  productionCompositionId && !apiKeyId ? productionCompositionId : undefined;

/** The run's enabled tools with the director tools added once, for a directed session; unchanged otherwise. */
export function withDirectedSessionTools(enabledTools: string[], input: DirectedSessionInput): string[] {
  if (!directedCompositionId(input)) return enabledTools;
  return [...new Set([...enabledTools, ...DIRECTOR_TOOLS])];
}

/**
 * The system context for a directed run: the director context, then the launch's own context unless it already
 * is that same text (the Direct launch sends it on its first run). Only once the production tools were actually
 * built (`productionToolsReady`), so a run without them is never told to use them.
 */
export function withDirectedSystemContext(
  systemContext: string | undefined,
  input: DirectedSessionInput & { productionToolsReady: boolean }
): string | undefined {
  const compositionId = directedCompositionId(input);
  if (!compositionId || !input.productionToolsReady) return systemContext;
  const directorContext = buildDirectorSystemContext(compositionId);
  if (!systemContext || systemContext.trim() === directorContext) return directorContext;
  return `${directorContext}\n\n${systemContext}`;
}

export const DIRECTED_NO_TOOL_CHECK =
  'You are answering without having called a production tool this turn, so nothing in the production has changed. ' +
  'If the user asked for any change, make it now with the production tools and report only what their results ' +
  'show. If they only asked a question, answer it and say you changed nothing. Never say a change was made, a ' +
  'voiceover redone or a cut assembled unless a tool result this turn shows it.';

/**
 * The host's `drainFeedback` for a directed run. A director that answers on the turn's first iteration called no
 * tool, and has been seen to describe edits it never made; this sends it back once with that fact. Later
 * iterations follow tool calls (or this check), so they pass. Null for a run that is not directed.
 */
export function directedFinalCheck(
  input: DirectedSessionInput & { productionToolsReady: boolean },
  iterationIndex: number
): ((phase: 'turn' | 'final') => Promise<string | null>) | undefined {
  if (!directedCompositionId(input) || !input.productionToolsReady) return undefined;
  let sent = false;
  return async phase => {
    if (phase !== 'final' || iterationIndex !== 0 || sent) return null;
    sent = true;
    return DIRECTED_NO_TOOL_CHECK;
  };
}
