/**
 * Anti-fabrication clause for the grounded/data-lake retrieval path, shared byte-identically by the
 * surfaces that put retrieved knowledge-base content in front of the model:
 *  - the forced-retrieval feature's success header (KnowledgeRetrievalFeature),
 *  - the model-driven semantic search result (search_knowledge_base),
 *  - the raw document read (retrieve_knowledge_content).
 *
 * NOT every grounding surface. An inlined file attachment (fabFileIds skips forced retrieval) carries no
 * retrieved-content wrapper for this to sit in; on a normal turn it leans on the always-on
 * ABSTENTION_PROMPT instead. A promptMode session is a real gap, not a covered case: filterByPromptMode
 * strips ABSTENTION_PROMPT along with every authored prompt (ChatCompletionProcess.ts:2495), so neither
 * this rule nor the abstention licence reaches it - an eval/passthrough surface uncovered by design.
 *
 * Under a leading question ("what did we win against <competitor>", "what was the <customer>
 * contract worth"), a grounded model tends to answer from the retrieved passages AND top them off
 * with a specific customer, deal or dollar figure the corpus never contained - volunteered with
 * citation-like framing, so it reads as sourced and quotable. The existing "ground your answer /
 * say so if not covered" framing does not name that failure, so this states it: attribute only the
 * checkable specifics the retrieved content or a labeled Memory/Reference fact supports (a claim made
 * earlier in the conversation is not one), and never dress an unsupported one as a citation.
 *
 * The mirror failure is fabricated ABSENCE: asked whether the corpus's owner offers or has something
 * real that the retrieved passages happen not to mention, a grounded model slides from "not in my
 * sources" to a confident "no, that does not exist / is not offered" - a false denial about the owner's
 * own domain, worse than abstaining, and not caught by the "don't invent facts" framing above. The rule
 * forbids that too: absence from retrieval is absence of information, not evidence the thing is unreal.
 * Kept as one shared const so the surfaces cannot drift apart.
 */
export const GROUNDED_NO_INVENTION_RULE =
  'Ground every specific claim in the retrieved content, or in a fact shown above under a "Memory" or ' +
  '"Reference facts" label. A claim made earlier in the conversation - including one the user stated - is ' +
  'not such a fact and does not, on its own, make a specific detail supported. ' +
  'Do not state a specific customer, organization, person, competitive win or comparison, deal, price, or ' +
  'figure unless it appears there - even if the question presents it as already given - and never attach a ' +
  'citation to a claim they do not support. If a specific fact is not present, say it is not covered rather ' +
  'than supplying one from general knowledge or assumption. ' +
  'Absence from the retrieved content means you lack information about something, not that it is absent ' +
  'from the world: never state or imply that a product, capability, partnership, or offering does not ' +
  'exist, is not real, or is not provided merely because it is not present here - say it is not in the ' +
  'retrieved content (and, where useful, where it might be confirmed) rather than denying it.';

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
