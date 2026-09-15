import { parseArtifacts, convertCodeBlocksToArtifacts } from '@bike4mind/utils';

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
 * Dedup is by artifact identifier (falling back to trimmed content when a block
 * has no identifier), against BOTH the parent's own artifacts and earlier child
 * blocks - so a block the parent reproduced, or two children emitting the same
 * id, renders exactly once. Extraction mirrors chat's pipeline
 * (`convertCodeBlocksToArtifacts` then `parseArtifacts`) so fenced chart/code
 * output counts the same as explicit `<artifact>` tags.
 */
export function collectDagChildArtifactBlocks(args: { parentAnswer: string; childAnswers: string[] }): string[] {
  const { parentAnswer, childAnswers } = args;

  const keyOf = (a: { identifier?: string; content: string }): string =>
    a.identifier ? `id:${a.identifier}` : `content:${a.content.trim()}`;

  const parseBlocks = (text: string) => (text ? parseArtifacts(convertCodeBlocksToArtifacts(text)).artifacts : []);

  // Seed the seen-set with the parent's own artifacts so a block the parent
  // already reproduced isn't rendered a second time.
  const seen = new Set(parseBlocks(parentAnswer).map(keyOf));

  const blocks: string[] = [];
  for (const answer of childAnswers) {
    for (const artifact of parseBlocks(answer)) {
      const key = keyOf(artifact);
      if (seen.has(key)) continue;
      seen.add(key);
      blocks.push(artifact.fullMatch.trim());
    }
  }
  return blocks;
}
