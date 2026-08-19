import { buildReplToolSystemPrompt, type ReplToolDescriptor } from '@bike4mind/agents';

/**
 * Data-lake REPL tool descriptors and the canned system-prompt fragment
 * that lists them.
 *
 * Lives here (not in the generic `@bike4mind/agents/rlm` package) because
 * these descriptors match the data-lake tool implementations in `tools.ts`
 * in this same folder. Other consumers of the persistent-REPL pattern
 * (tavern, future agents) pass their own descriptor sets.
 */

export const DATA_LAKE_REPL_TOOLS: ReplToolDescriptor[] = [
  {
    name: 'semanticSearch',
    signature: '({ query, top_k = 10, min_score = 0, tags = [] })',
    description:
      'Vector / semantic search across chunked articles in the data lake. ' +
      'Returns { results: [{ file_id, file_name, file_tags, chunk_text, score }, ...], total_chunks_searched, ' +
      'files_in_scope, chunks_scored, partial_results, embedding_mismatch, retrieval_unavailable, ' +
      'warning, scan: { truncated, files_scanned, files_matching, ... }, ... }. ' +
      'If partial_results is true some content was WITHHELD, for one of three reasons: it could not be ' +
      'compared (embedding_mismatch says what and why); it is mid-re-index and temporarily unsearchable ' +
      '(retrieval_unavailable.indexing_files); or a paused re-process left it with no searchable passages ' +
      'and it is not coming back on its own (retrieval_unavailable.paused_files). `warning` states which and ' +
      'names the files. Say so instead of presenting the result as complete. The remedies differ: re-indexing ' +
      'files just need the search re-run later, whereas paused ones need the lake\'s passages rebuilt or the ' +
      'files reprocessed - do NOT tell the reader to wait, and do not assume the kill switch is still on, ' +
      'because the marker outlives the pause that caused it. ' +
      'If scan.truncated is true the search covered only part of the lake, so widen with ' +
      'listArticles or keywordSearch before concluding something is absent.',
  },
  {
    name: 'keywordSearch',
    signature: '({ query, limit = 10, tags = [] })',
    description:
      'Keyword (Mongo $text) search on filename + tags + notes. Useful for ' +
      'exact-phrase matches and tag-filtered enumeration. Returns ' +
      '{ data: [{ _id, file_id, fileName, file_name, tag_names, tags, notes, ... }], total, hasMore }.',
  },
  {
    name: 'listArticles',
    signature: '({ tag, limit = 50, page = 1 })',
    description:
      'Browse articles by exact tag (no query). Useful for enumerating an ' +
      'entire pattern family (e.g., tag: "opti:family:scheduling").',
  },
  {
    name: 'getArticle',
    signature: '({ file_id, max_chars = 12000 })',
    description:
      'Fetch the full body of a specific article. Returns ' +
      '{ file_id, file_name, file_tags, content, truncated }. ' +
      'file_id must be a 24-char hex ObjectId from a search result.',
  },
  {
    name: 'subAgentQuery',
    signature: "({ prompt, model = 'haiku', max_tokens = 1500 })",
    description:
      'Ask a fast leaf LLM (Claude Haiku) a question. Returns a string. ' +
      'Use this inside loops to extract / classify / verify per-chunk ' +
      'information without burning your own context. Each call counts ' +
      'against your sub-LLM budget.',
  },
];

/**
 * The data-lake REPL prompt, for callers that don't want to specify the
 * tool list manually. Used by `/api/opti/rlm-answer`.
 */
export const REPL_TOOL_SYSTEM_PROMPT = buildReplToolSystemPrompt({
  tools: DATA_LAKE_REPL_TOOLS,
});
