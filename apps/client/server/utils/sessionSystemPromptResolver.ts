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
 *
 * CACHED, short-TTL, per-process. A surface now DOES set `session.systemPromptId` (a data lake's
 * preferred prompt), so this runs on the per-turn completion path AND on the identity-suppression
 * decision in `/api/ai/llm` - two Mongo reads (`findByPromptId` + `getActiveContent`) each. The
 * cache, keyed by promptId, keeps a busy session from re-reading the same prompt every turn; an
 * admin edit takes effect within the TTL. Mirrors `identityPromptCache` in `systemPrompts/loader.ts`
 * (per-Lambda-container, best-effort, correctness never depends on it). A null result (disabled or
 * unknown) is cached too, so a disabled prompt is not re-read every turn either.
 */
const RESOLVED_PROMPT_CACHE_TTL_MS = 60_000;
const resolvedPromptCache = new Map<string, { content: string | null; expiresAt: number }>();

/** Test-only: drop the in-process cache so a mocked resolution in one test cannot leak into the next. */
export const __resetResolvedPromptCache = (): void => resolvedPromptCache.clear();

export const loadSystemPromptById = async (promptId: string): Promise<string | null> => {
  if (!isSessionActivatablePromptId(promptId)) return null;
  const now = Date.now();
  const cached = resolvedPromptCache.get(promptId);
  if (cached && cached.expiresAt > now) return cached.content;
  const resolved = await loadSystemPromptContent(promptId);
  const content = resolved?.content ?? null;
  resolvedPromptCache.set(promptId, { content, expiresAt: now + RESOLVED_PROMPT_CACHE_TTL_MS });
  return content;
};

/**
 * Will this session actually get an authored system prompt injected at completion time?
 *
 * The suppression decision in `/api/ai/llm` (skip the generic brand identity when the session
 * carries its own prompt) MUST ask THIS, not mere allowlist membership. `systemPromptId` is a
 * reference the completion path RESOLVES, and an allowlisted id whose registry record an admin has
 * disabled - or a lake bound to a since-delisted id - resolves to null. Deciding suppression from
 * membership alone would then suppress the identity AND inject nothing, leaving the session with no
 * system prompt at all. Resolving here closes that: an unresolvable id reports false, so the caller
 * injects the generic identity instead. Raw `systemPromptText` is authored by definition and needs
 * no resolution (whitespace-only does not count, matching how the completion path reads it).
 */
export const sessionWillInjectAuthoredPrompt = async (session: {
  systemPromptText?: string;
  systemPromptId?: string;
}): Promise<boolean> => {
  if (session.systemPromptText?.trim()) return true;
  if (!session.systemPromptId) return false;
  return (await loadSystemPromptById(session.systemPromptId)) !== null;
};
