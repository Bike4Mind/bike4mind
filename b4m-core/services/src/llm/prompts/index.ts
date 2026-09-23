import { SEARCH_RESULT_CARDS_LANGUAGE } from '@bike4mind/common';

/**
 * Anti-fabrication clause for the grounded/data-lake retrieval path, shared byte-identically by the
 * surfaces that put retrieved knowledge-base content in front of the model:
 *  - the forced-retrieval feature's success header (KnowledgeRetrievalFeature),
 *  - the model-driven semantic search result (search_knowledge_base),
 *  - the raw document read (retrieve_knowledge_content).
 *
 * NOT every grounding surface. An inlined file attachment (fabFileIds skips forced retrieval) carries no
 * retrieved-content wrapper for this to sit in; on a normal turn it leans on the always-on
 * ABSTENTION_PROMPT instead. Under a promptMode the two part company, and the distinction matters:
 * filterByPromptMode strips ABSTENTION_PROMPT in ALL THREE modes (no mode admits the `abstention`
 * source), but this rule is not an authored prompt - KnowledgeRetrievalFeature splices it into the
 * retrieved-content block itself, and `grounded`/`surface` both admit `knowledgeRetrieval` and keep
 * forced retrieval on, so a retrieval that finds content still carries it. The uncovered surface is
 * any turn answering with NO retrieved content: `raw` always, and a grounded/surface turn that found
 * nothing. A caller who needs the knowledge auto-offer withheld without opening even that gap sets
 * the `skipAutoOffers` request field instead of a mode; the two were one switch until it cost a
 * measurement.
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
 *
 * The premise-challenge shape is the same slide with the specific supplied by the QUESTION - "how did
 * <vendor> get <N>% faster with us". Retrieval returns nothing, the model scopes the absence correctly
 * for a sentence or two, then escalates past abstention into a verdict on the claim ("the premise
 * appears to be fabricated"). The entity-shaped enumeration above did not reach it - product,
 * capability, partnership, offering, and a claimed RESULT is none of those - so the closing sentences
 * name that case directly. It is the worst-travelling form of the failure: it reads as adjudicated
 * rather than merely unknown, and a rep repeats it to the prospect it was about.
 *
 * A further failure sits inside "leave the claim open" itself: a model that avoids a yes/no verdict
 * can still answer the named gap with an invented figure or name, which passes as compliant since it
 * never denies the premise. The clause below binds the licence at the point it is granted: leaving a
 * claim open means declining to answer it, not only declining to rule on it.
 *
 * DO NOT REPAIR THIS BY EXTENDING THE WORD LIST. The first fix for the shape above did exactly that,
 * adding "false, fabricated, invented, made up" - and measured against the full retrieval stack the
 * model simply answered "No, it is not accurate to say <vendor> saw <N>%", reaching the same verdict
 * with none of the listed words. That is the ORIGINAL defect's flaw repeated one level down: an
 * enumeration is only ever as wide as the paraphrases someone thought of. Hence the three clauses that
 * replaced it, none of which is a word: decline the yes/no outright; say which speech act IS allowed
 * instead (unsupported, uncited, not approved for external use), because a ban with nowhere to go is
 * what left the model reaching for a synonym; and name what those failing replies actually reasoned
 * from - a corpus that presents itself as a complete register reads as a complete world. The word list
 * survives only as an illustration inside the second clause.
 *
 * Those clauses forbid a CHARACTERISATION of a claim, not a computation, so they leave the derive
 * licence below untouched: nothing in them tells the model to stop doing arithmetic in front of the
 * user. Nor do they suppress CONFIRMING a claim the retrieved content does support - they are scoped
 * to a result the content does not contain, and evals/groundedNoInvention has a case for each of those
 * two over-corrections (`derive/`, `grounded-answer/confirm-supported-claim`).
 *
 * A THIRD direction was not anticipated, and a paired measurement found it: told to leave the claim
 * open, the model stopped adjudicating and started ELABORATING instead - asserting a mechanism, citing
 * benchmarks, inventing percentages and a comparison baseline for a result the corpus never contained.
 * Same instruction, opposite half. The two anticipated over-corrections held; this one was simply not
 * named, because "leave the claim open" says nothing about what fills the space that leaves. Hence the
 * sentences defining the act and naming the licensed alternative - what the content DOES cover, and
 * where the claim could be confirmed - on the same reasoning as the clauses above: a ban with nowhere
 * to go is what sends the model looking for a workaround.
 *
 * That addition is a CHARACTERISATION AND ELABORATION ban, not a computation ban, and it is scoped to
 * the absent claim: explaining a mechanism the retrieved content itself supplies is still wanted, and
 * `grounded-answer/explain-supported-mechanism` is the case that catches a model that stopped.
 * NOT another entry on the word list - see the paragraph above for why that road is closed.
 *
 * A MEASURED BEHAVIOUR DEPENDS ON THIS RULE'S SCOPE. `triage_router` STEP 1 (apps/client/server/utils/
 * systemPrompts/defaults.ts) tells the model to DERIVE figures the request supplies the inputs for -
 * size a problem, carry the arithmetic - and to label them as derived. That is deliberately outside
 * this rule, which governs facts asserted as *retrieved*: "do not state a specific ... figure unless
 * it appears there" is about sourcing a claim, not about doing arithmetic in front of the user.
 *
 * The two were measured together (both arms carried this rule) and the split was worth +25.2 composite
 * on a resource-sizing question the model had previously refused to compute. **If this rule is ever
 * widened to cover derived or computed figures, that behaviour regresses** - and it will regress
 * silently, because the router's own tests assert only the router's text and nothing here asserts this
 * boundary. Re-measure with optihashi-eval rather than reasoning it through.
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
  'retrieved content (and, where useful, where it might be confirmed) rather than denying it. ' +
  'That holds for a claim the question itself asserts. When the user asks about a specific result, ' +
  'engagement, or event the retrieved content does not contain, report that it is not in the retrieved ' +
  'content and leave the claim itself open, and leaving it open means not answering it, including not ' +
  'answering it from general knowledge, inference, or a plausible-sounding estimate; do not explain how ' +
  'the asserted result was reached, what it was measured against, or what figures it involved, and do ' +
  'not supply any of that from general knowledge, published results, or what is typically the case. ' +
  'What you may offer instead is what the retrieved content does cover and where the claim could be ' +
  'confirmed. If they ask whether such a claim is accurate, true, or ' +
  'correct, do not answer yes or no. Report what the retrieved content does and does not show: you ' +
  'may say the claim is unsupported, uncited, or not approved for external use, but never that it is ' +
  'false, inaccurate, fabricated, invented, or made up, and do not reach that verdict in other words. ' +
  'A register or approved list bounds what you may cite, not what happened. Reporting the limits of ' +
  'what you retrieved is not a ruling on what happened.';

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

/**
 * Teaches the `b4m_cards` fence, appended to a web_search result ONLY when that search actually
 * returned images (see shouldIncludeImages). Delivering it with the results rather than in the system
 * prompt costs nothing on the turns that will never use it, and arrives exactly when it is actionable.
 *
 * The field names must stay in sync with the parser in
 * apps/client/app/components/Session/parseSearchResultCards.ts; the fence language is shared.
 */
export const WEB_SEARCH_CARDS_PROMPT = [
  'The results above include images, so illustrate your answer - do not wait to be asked. When you name specific',
  `things the user would want to SEE, emit a \`\`\`${SEARCH_RESULT_CARDS_LANGUAGE} fenced block inline in your reply, placed`,
  'exactly where the pictures belong - right after the sentence that introduces them, not at the end.',
  'The block is a single JSON object:',
  '',
  `\`\`\`${SEARCH_RESULT_CARDS_LANGUAGE}`,
  '{"cards":[{"name":"Orient Bambino","note":"Your own description of this thing, in your voice.",',
  '"meta":"~$200","url":"https://orientwatch.co/bambino","images":[',
  '{"url":"https://example.com/a.jpg","source":"orientwatch.co"},',
  '{"url":"https://example.com/b.jpg","source":"jomashop"}]}]}',
  '```',
  '',
  'Rules: `name` and at least one `images` entry are required. Every image `url` must be copied verbatim',
  "from an `image:` or Images line above, never invented or guessed, and `source` is that entry's own",
  '`source`/hostname, so each picture is attributed. Prefer the "Images found for this search" pool:',
  'those carry their own page and publisher. `note` is YOUR prose about the thing, not the',
  'search snippet. `meta` is a short footer such as a price or key spec. `url` is where the card links.',
  'Two to six cards is the useful range. Keep writing normally around the block - it replaces neither',
  'your explanation nor your citations. Omit the block only if the results genuinely have no images',
  'worth showing; never tell the user you could show pictures if they asked - just show them.',
].join('\n');
