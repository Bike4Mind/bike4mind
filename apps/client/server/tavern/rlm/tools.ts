import Anthropic from '@anthropic-ai/sdk';
import type { ReplToolMap, ReplSession } from '@bike4mind/agents';
import type { PrincipalAuthHeaders } from './principalAuthHeaders';
import { TOOL_HTTP_TIMEOUT_MS } from './timeouts';

/**
 * Tool functions that get exposed inside the REPL for an RLM-style agent.
 *
 * The agent calls these as ordinary async JS functions inside an
 * `code_execute` block. Each tool either hits a B4M API endpoint over
 * HTTP (data-lake retrieval) or uses the Anthropic SDK directly
 * (sub-LLM delegation).
 *
 * Spike-grade: HTTP calls back to `localhost:3000/api/data-lakes/*` from
 * inside the Node process. Production (Quest 3 in the architecture
 * doc) replaces this with in-process service calls and Bedrock-routed
 * sub-LLM calls so we drop the loopback hop and match the rest of the
 * tavern's LLM routing.
 *
 * See: apps/client/server/tavern/docs/07-PERSISTENT-REPL-TOOL.md
 */

export interface DataLakeToolDeps {
  /** Base URL for B4M API calls. Default: http://localhost:3000 */
  baseUrl: string;
  /**
   * The requesting principal's own credential headers, replayed on every
   * loopback call so retrieval is scoped to the caller and not to some shared
   * identity. Build with `resolvePrincipalAuthHeaders(req.headers)`.
   */
  authHeaders: PrincipalAuthHeaders;
  /** Direct Anthropic API key for sub-LLM calls. */
  anthropicApiKey: string;
  /** Session whose budget the sub-LLM cost is recorded against. */
  session: ReplSession;
  /** Default sub-LLM model. */
  subLlmModel?: string;
}

const HAIKU_MODEL_ID = 'claude-haiku-4-5-20251001';

/**
 * The models `subAgentQuery` may dispatch to, and the per-token rates their
 * spend is charged at. Membership and pricing are the same fact on purpose:
 * the session cost cap is only a cap if every model it can reach is priced,
 * so a model that is not in this table cannot be called.
 *
 * `model` reaches this from LLM-authored code inside the REPL, so treat an
 * unrecognised id as input to reject, not a value to pass through. It used to
 * be forwarded to the provider verbatim and then billed at Haiku's rate, which
 * under-counted an Opus call by ~19x and let one request quietly outspend its
 * own cap.
 *
 * Rates are USD per token, at Anthropic's published first-party list price.
 * Update alongside provider pricing changes. A `Map`, not an object literal,
 * because membership doubles as the allowlist: `SUB_LLM_PRICING[model]` on a
 * plain object resolves inherited keys, so a `model` of "constructor" (or
 * "toString", "valueOf", ...) passed the truthiness check and reached the
 * provider. A Map has no prototype chain to walk.
 */
const SUB_LLM_PRICING = new Map<string, { inputPerToken: number; outputPerToken: number }>([
  // Claude Haiku 4.5: $1.00 / MTok in, $5.00 / MTok out. Was entered at
  // Haiku 3.5's $0.80 / $4.00, which under-priced every call by 20% - and the
  // cap is only as tight as the numbers behind it.
  [HAIKU_MODEL_ID, { inputPerToken: 1e-6, outputPerToken: 5e-6 }],
]);

/** Rough chars-per-token for the pre-flight cost estimate. Settled with real
 *  usage as soon as the call returns, so it only has to be the right order. */
const ESTIMATE_CHARS_PER_TOKEN = 4;

/** One shared abort signal per tool call - see `timeouts.ts` for the ladder. */
const toolHttpDeadline = () => AbortSignal.timeout(TOOL_HTTP_TIMEOUT_MS);

interface SemanticSearchArgs {
  query: string;
  top_k?: number;
  min_score?: number;
  tags?: string[];
}

interface KeywordSearchArgs {
  query: string;
  limit?: number;
  tags?: string[] | string;
  page?: number;
}

interface ListArticlesArgs {
  tag?: string;
  limit?: number;
  page?: number;
}

interface GetArticleArgs {
  /** B4M FabFile id (`_id` from the listing endpoint). */
  file_id: string;
  /** Cap chars returned. Default 12_000, max 60_000. */
  max_chars?: number;
}

interface SubAgentQueryArgs {
  prompt: string;
  /** `'haiku'` or a key of SUB_LLM_PRICING. Anything else is refused. */
  model?: string;
  max_tokens?: number;
}

/**
 * Build the tool map to inject into a ReplContext for an agent operating
 * over the data lake.
 */
export function buildDataLakeTools(deps: DataLakeToolDeps): ReplToolMap {
  const anthropic = new Anthropic({ apiKey: deps.anthropicApiKey });
  const baseUrl = deps.baseUrl.replace(/\/+$/, '');
  const headers = { ...deps.authHeaders, 'Content-Type': 'application/json' };

  // HTTP loopback to the semantic-search route, which resolves dynamic lakes as well as the
  // static registry. Its scope is still a subset of the browse scope rlm-answer gates on
  // (see server/dataLakes/index.ts), so listArticles can surface a lake this cannot search.
  const semanticSearch = async (...args: unknown[]) => {
    const a = (args[0] ?? {}) as SemanticSearchArgs;
    if (!a.query) throw new Error('semanticSearch: query is required');
    const r = await fetch(`${baseUrl}/api/data-lakes/semantic-search`, {
      method: 'POST',
      signal: toolHttpDeadline(),
      headers,
      body: JSON.stringify({
        query: a.query,
        top_k: a.top_k ?? 10,
        min_score: a.min_score ?? 0,
        tags: a.tags ?? [],
      }),
    });
    if (!r.ok) throw new Error(`semanticSearch ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };

  // Internal: reshape an article record so `tags` is a flat array of names
  // instead of `[{ name, strength }, ...]`. Makes the agent's `console.log`
  // calls produce readable strings instead of `[object Object]`.
  const flattenArticle = (a: Record<string, unknown>) => {
    const rawTags = a.tags;
    const tag_names = Array.isArray(rawTags)
      ? rawTags.map(t =>
          typeof t === 'object' && t !== null && 'name' in t ? String((t as { name: unknown }).name) : String(t)
        )
      : [];
    return {
      ...a,
      file_id: a._id ?? a.id,
      file_name: a.fileName,
      tag_names,
      // Keep the original `tags` array too so power users can still inspect
      // strength scores. The default-friendly accessor is `tag_names`.
    };
  };

  const keywordSearch = async (...args: unknown[]) => {
    const a = (args[0] ?? {}) as KeywordSearchArgs;
    if (!a.query) throw new Error('keywordSearch: query is required');
    const params = new URLSearchParams();
    params.set('search', a.query);
    params.set('limit', String(a.limit ?? 10));
    if (a.page) params.set('page', String(a.page));
    if (Array.isArray(a.tags)) {
      for (const t of a.tags) params.append('tags', t);
    } else if (typeof a.tags === 'string') {
      params.append('tags', a.tags);
    }
    const r = await fetch(`${baseUrl}/api/data-lakes/articles?${params}`, {
      method: 'GET',
      signal: toolHttpDeadline(),
      headers: { ...deps.authHeaders },
    });
    if (!r.ok) throw new Error(`keywordSearch ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const payload = (await r.json()) as { data?: Record<string, unknown>[]; total?: number; hasMore?: boolean };
    return {
      data: (payload.data ?? []).map(flattenArticle),
      total: payload.total ?? 0,
      hasMore: payload.hasMore ?? false,
    };
  };

  const listArticles = async (...args: unknown[]) => {
    const a = (args[0] ?? {}) as ListArticlesArgs;
    const params = new URLSearchParams();
    params.set('limit', String(a.limit ?? 50));
    if (a.page) params.set('page', String(a.page));
    if (a.tag) params.append('tags', a.tag);
    const r = await fetch(`${baseUrl}/api/data-lakes/articles?${params}`, {
      method: 'GET',
      signal: toolHttpDeadline(),
      headers: { ...deps.authHeaders },
    });
    if (!r.ok) throw new Error(`listArticles ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const payload = (await r.json()) as { data?: Record<string, unknown>[]; total?: number; hasMore?: boolean };
    return {
      data: (payload.data ?? []).map(flattenArticle),
      total: payload.total ?? 0,
      hasMore: payload.hasMore ?? false,
    };
  };

  const getArticle = async (...args: unknown[]) => {
    const a = (args[0] ?? {}) as GetArticleArgs;
    // Defensive validation: invalid file_id is a common failure mode (the
    // agent passes `undefined` or an empty string from a stale variable).
    // Surface the bug to the agent clearly instead of an opaque 404.
    if (typeof a.file_id !== 'string' || !a.file_id.trim()) {
      throw new Error(
        'getArticle: file_id must be a non-empty string. ' +
          'Pass an `_id` value from semanticSearch results or keywordSearch.data[*]._id.'
      );
    }
    // Mongo ObjectIds are 24-char hex; `chunk_id` from semanticSearch is also
    // a 24-char hex but represents the chunk, not the file. Distinguish:
    if (!/^[a-f0-9]{24}$/i.test(a.file_id)) {
      throw new Error(
        `getArticle: file_id "${a.file_id}" is not a valid 24-char hex ObjectId. ` +
          "Check that you're passing the article _id (a.k.a. file_id), not chunk_id."
      );
    }
    const cap = Math.min(Math.max(a.max_chars ?? 12_000, 100), 60_000);

    // One deadline for all three requests below, created once so they share a
    // single wall-clock budget instead of each getting the full allowance.
    const signal = toolHttpDeadline();

    // Fetch metadata to learn the filePath
    const metaR = await fetch(`${baseUrl}/api/data-lakes/articles?id=${encodeURIComponent(a.file_id)}`, {
      signal,
      headers: { ...deps.authHeaders },
    });
    if (metaR.status === 404) {
      throw new Error(
        `getArticle: file_id "${a.file_id}" not found in your accessible data lakes ` +
          '(may be unindexed, deleted, or outside your permission scope).'
      );
    }
    if (!metaR.ok) throw new Error(`getArticle meta ${metaR.status}: ${(await metaR.text()).slice(0, 200)}`);
    const meta = await metaR.json();
    const article = (meta.data ?? [])[0];
    if (!article) throw new Error(`getArticle: file ${a.file_id} not found or not accessible`);

    // Get presigned URL and fetch the body
    const urlR = await fetch(
      `${baseUrl}/api/files/presigned-url?filePaths%5B%5D=${encodeURIComponent(article.filePath)}`,
      { signal, headers: { ...deps.authHeaders } }
    );
    if (!urlR.ok) throw new Error(`getArticle presigned ${urlR.status}`);
    const { urls } = (await urlR.json()) as { urls: string[] };
    const presigned = urls?.[0];
    if (!presigned) throw new Error('getArticle: no presigned URL returned');

    // Same shared deadline as the two calls above (see TOOL_HTTP_TIMEOUT_MS).
    // A stalled connection here used to hang `code_execute` past the REPL's
    // own host deadline, which retires the isolate for the whole session.
    const bodyR = await fetch(presigned, { signal });
    if (!bodyR.ok) throw new Error(`getArticle s3 ${bodyR.status}`);
    let body = await bodyR.text();
    let truncated = false;
    if (body.length > cap) {
      body = body.slice(0, cap) + `\n\n[...truncated to ${cap} of ${body.length} chars]`;
      truncated = true;
    }
    return {
      file_id: a.file_id,
      file_name: article.fileName,
      file_tags: (article.tags ?? []).map((t: { name: string }) => t.name),
      content: body,
      truncated,
    };
  };

  const subAgentQuery = async (...args: unknown[]) => {
    const a = (args[0] ?? {}) as SubAgentQueryArgs;
    if (!a.prompt) throw new Error('subAgentQuery: prompt is required');
    const requestedModel = !a.model || a.model === 'haiku' ? HAIKU_MODEL_ID : a.model;
    const pricing = typeof requestedModel === 'string' ? SUB_LLM_PRICING.get(requestedModel) : undefined;
    if (!pricing) {
      throw new Error(
        `subAgentQuery: model "${String(requestedModel)}" is not available. ` +
          `Allowed models: ${[...SUB_LLM_PRICING.keys()].join(', ')} (or "haiku").`
      );
    }
    const maxTokens = Math.min(Math.max(a.max_tokens ?? 1500, 16), 8000);

    // Claim the budget BEFORE the request goes out. Booking on the way back
    // cannot bound a fan-out: `await Promise.all(...)` over N calls would see
    // every check pass while all N are in flight, and the cap would only fire
    // once the provider had already billed all N. Worst-case pricing, since a
    // reservation that under-estimates is a cap that under-enforces.
    const reservation = deps.session.reserveSubLlm({
      estimatedCostUsd:
        Math.ceil(a.prompt.length / ESTIMATE_CHARS_PER_TOKEN) * pricing.inputPerToken +
        maxTokens * pricing.outputPerToken,
    });

    try {
      // Same deadline every other tool's HTTP work gets. Without it this call
      // was the one tool that could outlive its own tool-dispatch bound: the
      // dispatcher abandons the await at that bound, but the request kept
      // running and kept billing, and a retry paid for it a second time.
      const msg = await anthropic.messages.create(
        {
          model: requestedModel,
          max_tokens: maxTokens,
          messages: [{ role: 'user', content: a.prompt }],
        },
        { signal: toolHttpDeadline() }
      );
      // settle() throws BudgetExceededError when the real cost tips the
      // ceiling. Let it propagate: that throw is how the agent finds out.
      reservation.settle({
        costUsd: msg.usage.input_tokens * pricing.inputPerToken + msg.usage.output_tokens * pricing.outputPerToken,
        promptTokens: msg.usage.input_tokens,
        completionTokens: msg.usage.output_tokens,
      });
      return msg.content.map(block => ('text' in block ? block.text : '')).join('');
    } finally {
      // No-op once settled. This is the backstop for a throw anywhere between
      // the claim and the settle - a failed dispatch, a malformed usage
      // payload - so a claim can never leak and permanently shrink the
      // session's remaining budget.
      reservation.release();
    }
  };

  return {
    semanticSearch,
    keywordSearch,
    listArticles,
    getArticle,
    subAgentQuery,
  };
}
