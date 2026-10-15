import type {
  ToolCallingDistribution,
  ToolCallingRate,
  ToolCallingReport,
  ToolCallingScorecard,
  ToolCallingSegment,
} from './scorecard';

const SEGMENT_ORDER: readonly ToolCallingSegment[] = ['smart', 'fast', 'unset'];

function pct(rate: ToolCallingRate): string {
  return rate.rate === null ? 'n/a' : `${(rate.rate * 100).toFixed(1)}% (${rate.count}/${rate.total})`;
}

function num(value: number | null, digits = 0): string {
  return value === null ? 'n/a' : value.toFixed(digits);
}

function dist(d: ToolCallingDistribution, unit = ''): string {
  return d.samples === 0
    ? 'n/a'
    : `mean ${num(d.mean, 1)}${unit}, p50 ${num(d.p50)}${unit}, p95 ${num(d.p95)}${unit}, max ${num(d.max)}${unit}`;
}

function formatScorecard(label: string, card: ToolCallingScorecard): string[] {
  const lines = [
    `${label}: ${card.turns} turn(s), ${card.turnsOffered} offered tools`,
    `  calls per turn: ${dist(card.callsPerTurn)}`,
    `  wasted calls (repeat or not successful): ${pct(card.wasted)}`,
  ];
  for (const tool of card.tools) {
    const errors = Object.entries(tool.errorClasses)
      .map(([errorClass, count]) => `${errorClass} ${count}`)
      .join(', ');
    lines.push(
      `  ${tool.name}: calls ${tool.invocations}, success ${pct(tool.success)}` +
        `, offered-uncalled ${pct(tool.offeredUncalled)}, repeats ${tool.repeatedCalls}` +
        (tool.callsNotOffered > 0 ? `, not-offered ${tool.callsNotOffered}` : '') +
        `, latency ${dist(tool.latencyMs, 'ms')}` +
        (errors ? `; errors: ${errors}` : '')
    );
  }
  return lines;
}

/** The text summary for stdout; the JSON report is the full record. */
export function formatToolCallingReport(report: ToolCallingReport): string {
  const lines = [`tool-calling scorecard (${report.generatedAt})`, ...formatScorecard('overall', report.overall)];
  for (const segment of SEGMENT_ORDER) {
    const card = report.byToolMode[segment];
    if (card) lines.push(...formatScorecard(`toolMode=${segment}`, card));
  }
  return lines.join('\n');
}
