import { loadSystemPromptContent } from '@server/utils/systemPrompts/loader';
import { isSessionActivatablePromptId } from '@server/utils/sessionActivatablePrompts';

/**
 * The ONE implementation of `IChatCompletionServiceOptions.loadSystemPromptById`.
 *
 * Every factory that builds ChatCompletionProcess options must pass THIS - see the drift guard in
 * `apps/client/__tests__/sessionSystemPromptWiring.test.ts`. It is a shared module rather than an
 * inline lambda per factory because the inline version only ever reached one of them: the resolver
 * lived in `chatCompletionDefaults`, so `/api/ai/llm` (which dispatches every quest to the
 * always-on ChatCompletion worker) resolved `session.systemPromptId` to `undefined` and injected no
 * authored prompt at all, while the route had already suppressed the brand identity on the
 * assumption that it would. A capability wired per-factory is a capability that silently isn't.
 *
 * Returns null for an id the session is not allowed to activate, and for an unknown or
 * admin-disabled prompt - `ChatCompletionProcess` treats null as "no authored prompt".
 */
export const loadSystemPromptById = async (promptId: string): Promise<string | null> => {
  if (!isSessionActivatablePromptId(promptId)) return null;
  const resolved = await loadSystemPromptContent(promptId);
  return resolved?.content ?? null;
};
