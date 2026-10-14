import { buildToolEchoSourcesFromSteps } from '@bike4mind/services/llm';
import { parseArtifacts, convertCodeBlocksToArtifacts, createToolEchoMatcher } from '@bike4mind/utils';

/**
 * DAG subagent artifact bubble-up.
 *
 * A `coordinate_task` DAG runs its worker nodes as child executions; each child
 * emits its own final answer (with `<artifact>` tags when the emission prompt is
 * injected). On resume the parent re-summarizes the aggregated child report, and
 * that re-summarization may DROP the raw `<artifact>` blocks - so the parent's
 * completion text would lose the cards the children produced.
 *
 * Artifact cards render from the reply TEXT (the client parses `parseArtifacts`
 * over the message; durable persistence re-parses the same text). So to surface
 * child artifacts on the parent completion with no client change, we carry the
 * raw `<artifact>…</artifact>` blocks the children produced and append the ones
 * the parent didn't already reproduce to the parent's persisted reply text.
 *
 * Dedup is against BOTH the parent's own artifacts and earlier child blocks - so a block the
 * parent reproduced, or two children emitting the same block, renders exactly once. A
 * model-written `<artifact identifier=...>` block is keyed by identifier alone: the id is the
 * model's chosen identity, so a parent that refines a child's block under the same id
 * supersedes the child's draft rather than appending a stale second card under that id. A
 * promoted fence is keyed by identifier plus trimmed content, because promotion mints a
 * title-derived id ("python-script", "component") that two children's different scripts can
 * share. Extraction is the same pipeline the client render path runs
 * (`convertCodeBlocksToArtifacts` then `parseArtifacts`, one shared detector set in core) so
 * fenced chart/code output counts the same as explicit `<artifact>` tags. `childSteps[i]` is child i's persisted
 * steps: web tool output that child quoted back is not promoted, same as chat's echo matcher.
 */
export function collectDagChildArtifactBlocks(args: {
  parentAnswer: string;
  childAnswers: string[];
  childSteps?: ReadonlyArray<readonly unknown[] | undefined>;
}): string[] {
  const { parentAnswer, childAnswers, childSteps } = args;

  // A model-written `<artifact ...>` block survives conversion verbatim, so its fullMatch appears
  // in the raw reply; a promoted fence's synthesized block does not. That separates the two id
  // sources: explicit ids dedup by id alone, promoted ids also carry content.
  const keyOf = (a: { identifier?: string; content: string; fullMatch: string }, raw: string): string => {
    if (!a.identifier) return `content:${a.content.trim()}`;
    return raw.includes(a.fullMatch) ? `id:${a.identifier}` : `id:${a.identifier}:${a.content.trim()}`;
  };

  const parseBlocks = (text: string, steps?: readonly unknown[]) => {
    if (!text) return [];
    const sources = steps ? buildToolEchoSourcesFromSteps(steps) : [];
    const options = sources.length > 0 ? { isToolEcho: createToolEchoMatcher(sources) } : {};
    return parseArtifacts(convertCodeBlocksToArtifacts(text, options)).artifacts;
  };

  // Seed the seen-set with the parent's own artifacts so a block the parent
  // already reproduced isn't rendered a second time.
  const seen = new Set(parseBlocks(parentAnswer).map(a => keyOf(a, parentAnswer)));

  const blocks: string[] = [];
  for (const [i, answer] of childAnswers.entries()) {
    for (const artifact of parseBlocks(answer, childSteps?.[i])) {
      const key = keyOf(artifact, answer);
      if (seen.has(key)) continue;
      seen.add(key);
      blocks.push(artifact.fullMatch.trim());
    }
  }
  return blocks;
}
