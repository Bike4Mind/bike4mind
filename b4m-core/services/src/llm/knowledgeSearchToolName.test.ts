import { describe, expect, it } from 'vitest';
import { KNOWLEDGE_SEARCH_TOOL_NAME } from './ChatCompletionProcess';
import { knowledgeBaseSearchTool } from './tools/implementation/knowledgeBaseSearch';

/**
 * Drift guard, not a unit test. `resolveCorpusInlinePlan` refuses to defer the corpus when
 * `session.disabledTools` names the knowledge-search tool, and it matches that name as a string.
 * Renaming the tool without updating the constant would un-guard the path SILENTLY: the corpus
 * would be deferred to a tool that is then stripped, and no existing test would fail because
 * every one of them supplies the name itself. This is the only thing that would notice.
 */
describe('KNOWLEDGE_SEARCH_TOOL_NAME', () => {
  it('matches the name the knowledge-search tool actually registers under', () => {
    expect(KNOWLEDGE_SEARCH_TOOL_NAME).toBe(knowledgeBaseSearchTool.name);
  });
});
