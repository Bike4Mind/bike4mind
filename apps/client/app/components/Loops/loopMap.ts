import { stageConfigOf, type ILoop, type ILoopStageStats } from '@bike4mind/common';

export interface LoopMapInput {
  loop: Pick<ILoop, 'name' | 'stages' | 'stageConfig'>;
  /** Live tickets per stage (the tickets query the page already loads). */
  stageCounts: Record<string, number>;
  /** From the stats; without it the edges carry no figures. */
  byStage?: ILoopStageStats[];
  needsYou: number;
  /** Loops overseeing this one, drawn above it; loops it oversees, drawn below. */
  overseers: { name: string }[];
  workers: { name: string }[];
  /** Loops it hands tickets to (hand-off targets and stage triggers fed from it). */
  handoffTargets: { name: string }[];
}

/**
 * Stage and loop names are owner text: every character outside a small safe set becomes a mermaid entity code
 * (`#34;` for a quote), so a quote, bracket, pipe or semicolon can never end a label or start new syntax.
 */
export const mapLabel = (text: string): string =>
  `"${text.replace(/[^A-Za-z0-9 _.,:/()-]/g, char => `#${char.codePointAt(0)};`)}"`;

export function formatDuration(ms: number): string {
  const minutes = ms / 60_000;
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))}m`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / (24 * 60))}d`;
}

/**
 * The loop map as a mermaid flowchart: its stages left to right (name, runner, live tickets), forward edges labelled
 * with tickets entered and median time in the stage, dashed back-move edges, a human gate marker on each desktop stage
 * that merges on review, a Needs-you node, and the loops around it (overseers above, workers and hand-off targets
 * below). Node ids are synthetic, so no owner text is ever an id.
 */
export function buildLoopMap({
  loop,
  stageCounts,
  byStage,
  needsYou,
  overseers,
  workers,
  handoffTargets,
}: LoopMapInput): string {
  const stats = new Map((byStage ?? []).map(row => [row.stage, row]));
  const lines = ['flowchart TB', `  subgraph loop[${mapLabel(loop.name)}]`, '    direction LR'];

  loop.stages.forEach((stage, i) => {
    const config = stageConfigOf(loop, stage);
    const last = i === loop.stages.length - 1;
    const runner = last ? 'closed' : config.runner === 'desktop' ? 'desktop' : 'cloud';
    lines.push(`    s${i}[${mapLabel(`${stage} (${runner}) - ${stageCounts[stage] ?? 0}`)}]`);
    // A desktop stage whose work merges only once its owner approves the review.
    if (config.runner === 'desktop' && (config.mergePolicy ?? 'review') === 'review' && !last) {
      lines.push(`    g${i}{{${mapLabel('human gate')}}} -.- s${i}`);
    }
  });
  loop.stages.slice(1).forEach((stage, i) => {
    const from = stats.get(loop.stages[i]);
    const entered = stats.get(stage)?.entered;
    const parts = [
      entered !== undefined && `${entered} entered`,
      from?.medianTimeInStageMs != null && formatDuration(from.medianTimeInStageMs),
    ].filter(Boolean);
    lines.push(
      parts.length > 0 ? `    s${i} -->|${mapLabel(parts.join(' / '))}| s${i + 1}` : `    s${i} --> s${i + 1}`
    );
  });
  loop.stages.forEach((stage, i) => {
    const back = stats.get(stage)?.backMoves ?? 0;
    // Drawn to the previous stage: the stats count back-moves by the stage left, not by where they went.
    if (back > 0 && i > 0) lines.push(`    s${i} -.->|${mapLabel(`${back} back`)}| s${i - 1}`);
  });
  lines.push('  end');

  lines.push(`  needs((${mapLabel(`Needs you (${needsYou})`)}))`);
  lines.push('  loop -.- needs');
  overseers.forEach((other, i) => lines.push(`  o${i}[${mapLabel(other.name)}] -.->|oversees| loop`));
  workers.forEach((other, i) => lines.push(`  loop -.->|oversees| w${i}[${mapLabel(other.name)}]`));
  handoffTargets.forEach((other, i) => lines.push(`  loop -.->|hand-off| h${i}[${mapLabel(other.name)}]`));
  return lines.join('\n');
}
