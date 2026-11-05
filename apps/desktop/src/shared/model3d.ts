/**
 * Shared shapes for the 3D model pane: what main tells the renderer about the open model, what
 * the sandboxed engine hands back after a build, and the pure helpers both sides lean on.
 *
 * Main owns the open file (watching, writes, tool waits; see main/chat/model3d/ModelLiveView.ts).
 * The renderer owns the build (the b4m-model: engine frame) and drawing (three.js).
 */

export type ModelKind = 'model' | 'glb' | 'gltf' | 'stl';

export type ModelUnits = 'mm' | 'm';

export type ModelParam = { value: number; min: number; max: number; step: number };

export type ModelPartMesh = {
  name: string;
  color: string;
  /** xyz triples, in model units. */
  positions: Float32Array;
  indices: Uint32Array;
  /**
   * Where this part's node has its origin, in model units and model axes: the point it rotates
   * about when an engine animates it (a lid's hinge). Absent means the model origin.
   */
  pivot?: [number, number, number];
  /** The name of the part this one is nested under in the GLB, so it moves with it. */
  parent?: string;
  /**
   * Makes the part a joint: the direction it turns about through its pivot (right-hand rule), or
   * slides along with `motion: 'slide'`, in model axes.
   */
  axis?: [number, number, number];
  /**
   * With `axis`: how far it moves from the modelled pose (0). Degrees for a turn, e.g. [0, 110] for
   * a lid; model units for a slide, e.g. [0, 40] for a drawer.
   */
  range?: [number, number];
  /** How a joint moves: turns about its pivot (the default) or slides along its axis. */
  motion?: ModelMotion;
  /** glTF PBR, 0..1: 1 for bare metal (brass, iron). Absent means a non-metal. */
  metalness?: number;
  /** glTF PBR, 0..1: 0 is mirror-glossy, 1 fully matte. Absent means fairly matte (0.75). */
  roughness?: number;
  /** Shades curved faces smoothly (a barrel, a knob) while keeping sharp edges; absent means faceted. */
  smooth?: boolean;
};

export const MODEL_MOTIONS = ['turn', 'slide'] as const;
export type ModelMotion = (typeof MODEL_MOTIONS)[number];

/** A part that moves: what the pane's joint sliders and the GLB's animation clips are made from. */
export type ModelJoint = {
  name: string;
  motion: ModelMotion;
  axis: [number, number, number];
  range: [number, number];
};

export type ModelBuildOutcome =
  | { ok: true; parts: ModelPartMesh[]; params: Record<string, ModelParam>; units: ModelUnits }
  | { ok: false; error: string; line?: number };

export type ModelViewState = {
  path: string | null;
  kind: ModelKind | null;
  /** Bumped on every open and every change on disk; reports for an older generation are stale. */
  generation: number;
  /** The text of a `.model.js`; null for binary assets, which the renderer reads on demand. */
  source: string | null;
  missing: boolean;
};

export type ModelSummary = {
  parts: string[];
  size: [number, number, number];
  units: string;
  triangles: number;
  params: Record<string, number>;
  /** One line per part that has a pivot or a parent, e.g. `lid: pivot (0, 24, 38), in body`. */
  joints?: string[];
};

export type ModelBuildReport = {
  generation: number;
  ok: boolean;
  error?: string;
  line?: number;
  summary?: ModelSummary;
  /** Why a good build's sibling `.glb` was not written (a read-only folder, a full disk). */
  glbError?: string;
};

export const MODEL_VIEWS = ['front', 'back', 'left', 'right', 'top', 'iso'] as const;
export type ModelView = (typeof MODEL_VIEWS)[number];
export const DEFAULT_MODEL_VIEWS: ModelView[] = ['front', 'right', 'top', 'iso'];

/** How a screenshot poses the joints: as modelled, or each at the far end of its range. */
export const MODEL_POSES = ['rest', 'open'] as const;
export type ModelPose = (typeof MODEL_POSES)[number];

export const EMPTY_MODEL_STATE: ModelViewState = {
  path: null,
  kind: null,
  generation: 0,
  source: null,
  missing: false,
};

export function modelKindFor(path: string): ModelKind | null {
  const lower = path.toLowerCase();
  if (lower.endsWith('.model.js')) return 'model';
  if (lower.endsWith('.glb')) return 'glb';
  if (lower.endsWith('.gltf')) return 'gltf';
  if (lower.endsWith('.stl')) return 'stl';
  return null;
}

/** `chest.model.js` -> `chest.glb`, in the same directory; null for any other file, so an opened asset is never a target. */
export function siblingGlbPath(modelPath: string): string | null {
  return /\.model\.js$/i.test(modelPath) ? modelPath.replace(/\.model\.js$/i, '.glb') : null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rewrite the default `value:` of one param inside `export const params = { ... }`.
 *
 * A scoped pattern match rather than a parser: the params block is found by its export line and
 * brace-matched, and within it exactly one `key: { ... value: <number>` or bare `key: <number>` must
 * match, the number being the whole value (not `10 * 2` or `1e+3`). Zero or several matches return
 * null so the caller reports "not saved" instead of guessing.
 */
export function writeParamValue(source: string, key: string, value: number): string | null {
  if (!Number.isFinite(value)) return null;
  const head = /export\s+const\s+params\s*=\s*\{/.exec(source);
  if (!head) return null;
  const start = head.index + head[0].length - 1;
  let depth = 0;
  let end = -1;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  if (end < 0) return null;
  const block = source.slice(start, end + 1);
  const pattern = new RegExp(
    `(['"]?\\b${escapeRegExp(key)}\\b['"]?\\s*:\\s*(?:\\{[^{}]*?\\bvalue\\s*:\\s*)?)(-?\\d+(?:\\.\\d+)?(?:e-?\\d+)?)(?=\\s*[,}\\r\\n])`,
    'g'
  );
  const matches = [...block.matchAll(pattern)];
  if (matches.length !== 1) return null;
  const rounded = Number(value.toPrecision(12));
  const replaced = block.replace(pattern, (_whole, prefix: string) => `${prefix}${rounded}`);
  return source.slice(0, start) + replaced + source.slice(end + 1);
}

function formatNumber(value: number): string {
  return Number(value.toFixed(2)).toString();
}

/** The text the model tools return to the agent. */
export function formatModelSummary(report: ModelBuildReport, glbPath?: string): string {
  if (!report.ok) {
    const where = report.line ? ` (line ${report.line})` : '';
    return `Build failed${where}: ${report.error ?? 'unknown error'}\nFix the model file; the pane rebuilds on save.`;
  }
  const summary = report.summary;
  if (!summary) return 'Build succeeded.';
  const [x, y, z] = summary.size.map(formatNumber);
  const lines = [
    'Build succeeded.',
    `Size: ${x} x ${y} x ${z} ${summary.units} (x, y, z)`,
    `Parts: ${summary.parts.length ? summary.parts.join(', ') : '(one)'}`,
    `Triangles: ${summary.triangles}`,
  ];
  const params = Object.entries(summary.params);
  if (params.length) lines.push(`Params: ${params.map(([key, value]) => `${key}=${formatNumber(value)}`).join(', ')}`);
  if (summary.joints?.length) lines.push(`Joints: ${summary.joints.join('; ')}`);
  if (report.glbError) lines.push(`GLB not written: ${report.glbError}`);
  else if (glbPath) lines.push(`GLB written: ${glbPath}`);
  return lines.join('\n');
}

const isNumbers = (value: unknown, length: number): boolean =>
  Array.isArray(value) && value.length === length && value.every(Number.isFinite);

function partMaterialError(part: ModelPartMesh): string | null {
  for (const key of ['metalness', 'roughness'] as const) {
    const value = part[key];
    if (value !== undefined && !(Number.isFinite(value) && value >= 0 && value <= 1))
      return `Part "${part.name}" has a ${key} that is not a number from 0 to 1.`;
  }
  if (part.smooth !== undefined && typeof part.smooth !== 'boolean')
    return `Part "${part.name}" has a smooth that is not true or false.`;
  return null;
}

function partJointError(part: ModelPartMesh): string | null {
  const name = `Part "${part.name}"`;
  if (part.axis === undefined && part.range === undefined && part.motion === undefined) return null;
  if (part.motion !== undefined && !MODEL_MOTIONS.includes(part.motion))
    return `${name} has a motion that is not one of: ${MODEL_MOTIONS.join(', ')}.`;
  const slides = part.motion === 'slide';
  if (part.axis === undefined) return `${name} has a ${part.range ? 'range' : 'motion'} but no axis to move along.`;
  if (!isNumbers(part.axis, 3) || part.axis.every(value => value === 0))
    return `${name} has an axis that is not a direction [x, y, z], e.g. [1, 0, 0].`;
  const unit = slides ? 'model units' : 'degrees';
  if (part.range === undefined) return `${name} has an axis but no range [from, to] in ${unit}.`;
  if (!isNumbers(part.range, 2) || part.range[0] === part.range[1])
    return `${name} has a range that is not two different values [from, to] in ${unit}.`;
  // A slide moves the whole part, so it needs no pivot; a turn without one would spin about the model origin.
  if (!slides && !part.pivot) return `${name} has an axis but no pivot to turn about.`;
  return null;
}

/**
 * Why a set of parts cannot become a node tree, or null when it can. A part named as a parent has
 * to exist exactly once, following parents must never come back to where it started, and a joint
 * needs a pivot, a direction and two different limits.
 */
export function partTreeError(parts: ModelPartMesh[]): string | null {
  const counts = new Map<string, number>();
  for (const part of parts) counts.set(part.name, (counts.get(part.name) ?? 0) + 1);
  const byName = new Map(parts.map(part => [part.name, part]));
  for (const part of parts) {
    if (part.pivot && !(part.pivot.length === 3 && part.pivot.every(Number.isFinite))) {
      return `Part "${part.name}" has a pivot that is not three numbers [x, y, z].`;
    }
    const partError = partJointError(part) ?? partMaterialError(part);
    if (partError) return partError;
    if (part.parent === undefined) continue;
    if (part.parent === part.name) return `Part "${part.name}" cannot be its own parent.`;
    const count = counts.get(part.parent) ?? 0;
    if (count === 0) return `Part "${part.name}" names a parent "${part.parent}" that no part is called.`;
    if (count > 1)
      return `Part "${part.name}" names a parent "${part.parent}" that ${count} parts are called; parent names must be unique.`;
  }
  for (const part of parts) {
    const seen = new Set<string>([part.name]);
    let current = part.parent;
    while (current !== undefined) {
      if (seen.has(current)) return `Parts form a loop through "${current}"; a part cannot be nested inside itself.`;
      seen.add(current);
      current = byName.get(current)?.parent;
    }
  }
  return null;
}

/** The parts that turn, in part order. Assumes the parts passed partTreeError. */
export function jointsOf(parts: ModelPartMesh[]): ModelJoint[] {
  return parts.flatMap(part =>
    part.axis && part.range
      ? [{ name: part.name, motion: part.motion ?? 'turn', axis: part.axis, range: part.range }]
      : []
  );
}

/** The joint lines for ModelSummary: parts with a pivot or a parent, in model units. */
export function describeJoints(parts: ModelPartMesh[]): string[] {
  return parts
    .filter(part => part.pivot || part.parent || part.axis)
    .map(part => {
      const pivot = part.pivot
        ? `pivot (${part.pivot.map(formatNumber).join(', ')})`
        : part.motion === 'slide'
          ? 'no pivot'
          : 'pivot at origin';
      const [from, to] = (part.range ?? [0, 0]).map(formatNumber);
      const direction = `(${(part.axis ?? []).map(formatNumber).join(', ')})`;
      const turns = !(part.axis && part.range)
        ? ''
        : part.motion === 'slide'
          ? `, slides along ${direction} from ${from} to ${to}`
          : `, turns about ${direction} from ${from} to ${to} deg`;
      return `${part.name}: ${pivot}${part.parent ? `, in ${part.parent}` : ''}${turns}`;
    });
}
