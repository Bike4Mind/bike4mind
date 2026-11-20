import type { ModelPartMesh, ModelUnits } from './model3d';

/**
 * Point-and-edit: the user picks parts in the 3D model pane and types a change. The turn they send
 * carries a hidden note (ChatMessage.notes) that ties it to those parts: where in the model source
 * each one is built, where it sits and how big it is. The renderer writes the note, the model
 * reads it, and the thread reads its first lines back to draw the "Editing" chip, so the format
 * has exactly one owner: this file.
 */

export type ModelEditPart = {
  name: string;
  /** Model-source lines that built the part's geometry, ascending (the engine's provenance). */
  lines: number[];
  /** The line that lists the part by name, when the source has it as a literal. */
  declaredAt?: number;
  /** Axis-aligned bounds in model units, model axes (Z up). */
  min: [number, number, number];
  max: [number, number, number];
};

export type ModelEditContext = {
  path: string;
  units: ModelUnits;
  parts: ModelEditPart[];
  /** Lines that also build parts the user did not pick: a helper or a shared dimension. */
  sharedLines: number[];
  /** The file name of the attached close-up image, when one was rendered. */
  closeup?: string;
};

/** What the thread needs back from a sent note. */
export type ModelEditSummary = { parts: string[]; closeup?: string };

const HEADER = 'Point-and-edit request from the 3D model pane.';
const PARTS_PREFIX = 'Parts: ';
const CLOSEUP_PREFIX = 'Close-up: ';

/** [2, 3, 4, 9] reads as "2-4, 9". */
export function lineRanges(lines: readonly number[]): string {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0];
  for (let index = 0; index < sorted.length; index += 1) {
    const line = sorted[index];
    const next = sorted[index + 1];
    if (next === line + 1) continue;
    ranges.push(start === line ? `${line}` : `${start}-${line}`);
    start = next;
  }
  return ranges.join(', ');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The 1-based line that lists a part: its name as a string literal on a `name:` key, else the
 * first line with the name quoted at all. Undefined when the name is built at runtime.
 */
export function declarationLine(source: string, name: string): number | undefined {
  const quoted = `(['"\`])${escapeRegExp(name)}\\1`;
  const lines = source.split('\n');
  for (const pattern of [new RegExp(`\\bname\\s*:\\s*${quoted}`), new RegExp(quoted)]) {
    const index = lines.findIndex(line => pattern.test(line));
    if (index >= 0) return index + 1;
  }
  return undefined;
}

function millimetres(value: number, units: ModelUnits): number {
  return units === 'm' ? value * 1000 : value;
}

function formatMm(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Object.is(rounded, -0) ? '0' : `${rounded}`;
}

function describePart(part: ModelEditPart, context: ModelEditContext): string {
  const shared = part.lines.filter(line => context.sharedLines.includes(line));
  const where = [
    part.declaredAt !== undefined ? `listed at line ${part.declaredAt}` : 'not listed by a literal name',
    part.lines.length > 0
      ? `built by lines ${lineRanges(part.lines)}` +
        (shared.length > 0 ? ` (${lineRanges(shared)} also build${shared.length === 1 ? 's' : ''} other parts)` : '')
      : 'no source lines were traced, so find it by its name',
  ].join('; ');
  const axes = ['x', 'y', 'z'] as const;
  const bounds = axes
    .map((axis, index) => {
      const low = formatMm(millimetres(part.min[index], context.units));
      const high = formatMm(millimetres(part.max[index], context.units));
      return `${axis} ${low}..${high}`;
    })
    .join(', ');
  const size = axes.map((_axis, index) => formatMm(millimetres(part.max[index] - part.min[index], context.units)));
  return `- ${part.name}: ${where}; bounds ${bounds} mm, size ${size.join(' x ')} mm.`;
}

/** The hidden note a point-and-edit turn carries. Its first lines are what modelEditSummary reads. */
export function formatModelEditNote(context: ModelEditContext): string {
  const names = context.parts.map(part => part.name);
  const many = names.length > 1;
  return [
    HEADER,
    `${PARTS_PREFIX}${JSON.stringify(names)}`,
    ...(context.closeup ? [`${CLOSEUP_PREFIX}${context.closeup}`] : []),
    `The user picked ${many ? 'these parts' : 'this part'} in the model pane, in ${context.path}; their message is about ${many ? 'them' : 'it'}:`,
    ...context.parts.map(part => describePart(part, context)),
    `Change only the code for ${many ? 'these parts' : 'this part'} and keep every other part exactly as it is. Start from the lines above; change a line that also builds other parts only if the request needs it, and say so. Line numbers are from the build the user picked on: re-read the file first.`,
    'Save the file, then call model_view in a later batch (never in the same batch as the save), then check the change with model_screenshot before replying.',
    ...(context.closeup
      ? [
          `The attached ${context.closeup} is a close-up of the picked ${many ? 'parts' : 'part'}; the other parts are drawn faint.`,
        ]
      : []),
  ].join('\n');
}

/** The parts a turn edits, read back from its notes; null for any other turn. */
export function modelEditSummary(notes: readonly string[] | undefined): ModelEditSummary | null {
  for (const note of notes ?? []) {
    const lines = note.split('\n');
    if (lines[0] !== HEADER || !lines[1]?.startsWith(PARTS_PREFIX)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[1].slice(PARTS_PREFIX.length));
    } catch {
      continue;
    }
    if (!Array.isArray(parsed) || !parsed.every(name => typeof name === 'string')) continue;
    const closeup = lines[2]?.startsWith(CLOSEUP_PREFIX) ? lines[2].slice(CLOSEUP_PREFIX.length) : undefined;
    return { parts: parsed, ...(closeup ? { closeup } : {}) };
  }
  return null;
}

/** What point-and-edit keeps of a built part: its name, provenance and bounds, without the mesh. */
export type ModelPartFacts = Pick<ModelEditPart, 'name' | 'lines' | 'min' | 'max'>;

export function partFacts(parts: readonly ModelPartMesh[]): ModelPartFacts[] {
  return parts.map(part => {
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let index = 0; index < part.positions.length; index += 3) {
      for (let axis = 0; axis < 3; axis += 1) {
        const value = part.positions[index + axis];
        if (value < min[axis]) min[axis] = value;
        if (value > max[axis]) max[axis] = value;
      }
    }
    const empty = part.positions.length === 0;
    return {
      name: part.name,
      lines: part.lines ?? [],
      min: empty ? [0, 0, 0] : min,
      max: empty ? [0, 0, 0] : max,
    };
  });
}

/**
 * The context for a turn about `picked`, from the last good build. Picked names that are not in
 * the build are dropped; a name used twice resolves to its first part.
 */
export function modelEditContext(input: {
  path: string;
  source: string;
  units: ModelUnits;
  facts: readonly ModelPartFacts[];
  picked: readonly string[];
  closeup?: string;
}): ModelEditContext {
  const parts = input.picked.flatMap(name => {
    const fact = input.facts.find(entry => entry.name === name);
    if (!fact) return [];
    const declaredAt = declarationLine(input.source, name);
    return [{ ...fact, lines: [...fact.lines], ...(declaredAt !== undefined ? { declaredAt } : {}) }];
  });
  const otherLines = new Set(input.facts.filter(fact => !input.picked.includes(fact.name)).flatMap(fact => fact.lines));
  const sharedLines = [...new Set(parts.flatMap(part => part.lines))]
    .filter(line => otherLines.has(line))
    .sort((a, b) => a - b);
  return {
    path: input.path,
    units: input.units,
    parts,
    sharedLines,
    ...(input.closeup ? { closeup: input.closeup } : {}),
  };
}
