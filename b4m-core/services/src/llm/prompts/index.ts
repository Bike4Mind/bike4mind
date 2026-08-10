/**
 * Anti-fabrication clause for the grounded/data-lake retrieval path, shared byte-identically by
 * every surface that puts retrieved knowledge-base content in front of the model:
 *  - the forced-retrieval feature's success header (KnowledgeRetrievalFeature),
 *  - the model-driven semantic search result (search_knowledge_base).
 *
 * Under a leading question ("what did we win against <competitor>", "what was the <customer>
 * contract worth"), a grounded model tends to answer from the retrieved passages AND top them off
 * with a specific customer, deal or dollar figure the corpus never contained - volunteered with
 * citation-like framing, so it reads as sourced and quotable. The existing "ground your answer /
 * say so if not covered" framing does not name that failure, so this states it: attribute only the
 * checkable specifics the retrieved content supports, and never dress an unsupported one as a
 * citation. Kept as one shared const so the two surfaces cannot drift apart.
 */
export const GROUNDED_NO_INVENTION_RULE =
  'Ground every specific claim in the retrieved content shown here. Do not state a specific customer, ' +
  'organization, person, competitive win or comparison, deal, price, or figure unless it appears in that ' +
  'content - even if the question presents it as already given - and never attach a citation to a claim the ' +
  'content does not support. If a specific fact is not in the retrieved content, say it is not covered rather ' +
  'than supplying one from general knowledge or assumption.';

/**
 * Shared prompt snippet for preview-first tool confirmation rules.
 * Used by both GithubManagerAgent and ProjectManagerAgent.
 */
export function previewFirstToolsPrompt(tools: string[], example: { correct: string; wrong: string }): string {
  return `## Write Operations & Confirmation
Write tools have a built-in confirmation system. When you call them, they return a preview with Confirm/Cancel buttons — the user clicks to execute. **NEVER ask the user for text confirmation before calling a write tool.** Just call the tool immediately. The tool handles confirmation automatically.

**CRITICAL: When a write tool returns \`"confirmation_required": true\`, the action has NOT been executed yet.** It is a preview awaiting user confirmation via buttons. Your summary MUST say the action is **awaiting confirmation**, NOT that it was completed. Example:
- ✅ "${example.correct}"
- ❌ "${example.wrong}" (WRONG — it hasn't happened yet)

## Preview-First Tools
The following tools are **preview-first** and require button confirmation:
${tools.map(t => `\`${t}\``).join(', ')}

**Rules for these tools:**
1. ALWAYS call with \`confirmed=false\` to show a preview. NEVER set \`confirmed=true\`.
2. Only the button click executes the action. You cannot execute it.
3. DO NOT show the \`_confirmToken\` value — it is internal only.
The system will automatically add Confirm/Cancel buttons and format the preview.`;
}
