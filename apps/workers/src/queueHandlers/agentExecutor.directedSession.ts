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
