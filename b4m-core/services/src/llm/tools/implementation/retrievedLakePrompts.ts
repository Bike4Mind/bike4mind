import type { ToolContext } from '../base/types';
import { getAccessibleDataLakePrompts } from '../../../dataLakeService/getDataLakePrompts';
import { renderDataLakePromptSection } from '../../../dataLakeService/renderDataLakePromptBlock';

/**
 * Retrieval-scoped lake-prompt injection for the model-driven knowledge tools (#1108) - the
 * analogue of the forced path's scoped injection in KnowledgeRetrievalFeature. Prepends the
 * operating instructions of the trusted lakes whose files this tool call actually returned,
 * identified by the `datalake:` provenance tags on those files.
 *
 * `injectedLakeTags` is a per-TOOL set shared across that tool's calls in a completion: only lakes
 * NOT already injected by this tool contribute, so repeated calls to the SAME tool never restate a
 * lake. It is deliberately per-tool, not per-completion: search and retrieve each own their own set,
 * so a lake used by both within one turn is injected once per tool (idempotent, ~a few extra tokens).
 * The block rides INSIDE a tool RESULT, which is model-facing content, so it MUST carry the
 * renderDataLakePromptSection defenses (org-deference header + block-marker defang) - that is what
 * keeps a lake owner from forging an organization block. Fail-safe: any failure (and the agent-
 * scoped case, which passes no tags) returns the tool result unchanged.
 */
export async function prependRetrievedLakePrompts(
  context: ToolContext,
  resultText: string,
  datalakeTags: string[],
  injectedLakeTags: Set<string>
): Promise<string> {
  try {
    const fresh = datalakeTags.filter(tag => !injectedLakeTags.has(tag));
    if (fresh.length === 0) return resultText;
    // Mark every fresh RETRIEVED tag injected up front - including lakes that resolve to no prompt
    // (untrusted, or empty systemPrompt) - so a later call over the same lake is not re-resolved.
    for (const tag of fresh) injectedLakeTags.add(tag);

    const prompts = await getAccessibleDataLakePrompts(context, { restrictToDatalakeTags: fresh });
    const section = renderDataLakePromptSection(prompts);
    if (!section) return resultText;

    context.logger.log(
      `📋 KB tool: injecting ${prompts.length} scoped data-lake prompt(s): ${prompts.map(p => p.name).join(', ')}`
    );
    return `${section}\n\n${resultText}`;
  } catch (err) {
    context.logger.warn('📋 KB tool: lake-prompt resolution failed; injecting no lake prompt:', err);
    return resultText;
  }
}
