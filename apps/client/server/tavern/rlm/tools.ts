import Anthropic from '@anthropic-ai/sdk';
import type { ReplToolMap, ReplSession } from '@bike4mind/agents';

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
  /** Value for the `x-api-key` header on data-lake API calls. */
  apiKey: string;
  /** Direct Anthropic API key for sub-LLM calls. */
  anthropicApiKey: string;
  /** Session whose budget the sub-LLM cost is recorded against. */
  session: ReplSession;
  /** Default sub-LLM model. */
  subLlmModel?: string;
}

const HAIKU_MODEL_ID = 'claude-haiku-4-5-20251001';
// Approx Haiku 4.5 pricing (per token). Update when Anthropic changes prices.
const HAIKU_INPUT_PER_TOKEN = 0.8e-6;
const HAIKU_OUTPUT_PER_TOKEN = 4e-6;

// Track which sessions have already seen the non-Haiku-rate warning so a
// trajectory with N subAgentQuery calls only logs once.
const nonHaikuWarnedFor = new Set<string>();

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
  model?: 'haiku' | string;
  max_tokens?: number;
}

/**
 * Build the tool map to inject into a ReplContext for an agent operating
 * over the data lake.
 */
export function buildDataLakeTools(deps: DataLakeToolDeps): ReplToolMap {
  const anthropic = new Anthropic({ apiKey: deps.anthropicApiKey });
  const baseUrl = deps.baseUrl.replace(/\/+$/, '');
  const headers = { 'x-api-key': deps.apiKey, 'Content-Type': 'application/json' } as const;

  const semanticSearch = async (...args: unknown[]) => {
    const a = (args[0] ?? {}) as SemanticSearchArgs;
    if (!a.query) throw new Error('semanticSearch: query is required');
    const r = await fetch(`${baseUrl}/api/data-lakes/semantic-search`, {
      method: 'POST',
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
      headers: { 'x-api-key': deps.apiKey },
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
      headers: { 'x-api-key': deps.apiKey },
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

    // Fetch metadata to learn the filePath
    const metaR = await fetch(`${baseUrl}/api/data-lakes/articles?id=${encodeURIComponent(a.file_id)}`, {
      headers: { 'x-api-key': deps.apiKey },
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
      { headers: { 'x-api-key': deps.apiKey } }
    );
    if (!urlR.ok) throw new Error(`getArticle presigned ${urlR.status}`);
    const { urls } = (await urlR.json()) as { urls: string[] };
    const presigned = urls?.[0];
    if (!presigned) throw new Error('getArticle: no presigned URL returned');

    // 30s timeout on the S3 body fetch - without this, a stalled connection
    // hangs the agent's `code_execute` indefinitely. Caller's outer Lambda
    // timeout (55s) is the backstop, but local timeouts surface the failure
    // mode cleanly so the agent can retry/skip the article.
    const bodyR = await fetch(presigned, { signal: AbortSignal.timeout(30_000) });
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
    const requestedModel = a.model && a.model !== 'haiku' ? a.model : HAIKU_MODEL_ID;
    const maxTokens = Math.min(Math.max(a.max_tokens ?? 1500, 16), 8000);

    const msg = await anthropic.messages.create({
      model: requestedModel,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: a.prompt }],
    });
    const text = msg.content.map(block => ('text' in block ? block.text : '')).join('');

    // Cost accounting at Haiku rates. If the caller passed a non-Haiku
    // model (e.g. an opus snapshot for a hard task), the budget tracker
    // will UNDER-count the spend - warn once per session so the operator
    // knows the recorded session cost is an underestimate.
    if (requestedModel !== HAIKU_MODEL_ID && !nonHaikuWarnedFor.has(deps.session.sessionId)) {
      nonHaikuWarnedFor.add(deps.session.sessionId);
      console.warn(
        `[subAgentQuery] session=${deps.session.sessionId} requested model="${requestedModel}" ` +
          `but cost is being recorded at Haiku rates ($0.8/M in, $4/M out). ` +
          `Actual bill will exceed the recorded session cost.`
      );
    }
    const cost = msg.usage.input_tokens * HAIKU_INPUT_PER_TOKEN + msg.usage.output_tokens * HAIKU_OUTPUT_PER_TOKEN;
    deps.session.recordSubLlm({
      costUsd: cost,
      promptTokens: msg.usage.input_tokens,
      completionTokens: msg.usage.output_tokens,
    });

    return text;
  };

  return {
    semanticSearch,
    keywordSearch,
    listArticles,
    getArticle,
    subAgentQuery,
  };
}
