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
};

export type ModelBuildReport = {
  generation: number;
  ok: boolean;
  error?: string;
  line?: number;
  summary?: ModelSummary;
};

export const MODEL_VIEWS = ['front', 'back', 'left', 'right', 'top', 'iso'] as const;
export type ModelView = (typeof MODEL_VIEWS)[number];
export const DEFAULT_MODEL_VIEWS: ModelView[] = ['front', 'right', 'top', 'iso'];

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

/** `chest.model.js` -> `chest.glb`, in the same directory. */
export function siblingGlbPath(modelPath: string): string {
  return modelPath.replace(/\.model\.js$/i, '.glb');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rewrite the default `value:` of one param inside `export const params = { ... }`.
 *
 * A scoped pattern match rather than a parser: the params block is found by its export line and
 * brace-matched, and within it exactly one `key: { ... value: <number>` must match. Zero or
 * several matches return null so the caller reports "not saved" instead of guessing.
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
    `(['"]?\\b${escapeRegExp(key)}\\b['"]?\\s*:\\s*\\{[^{}]*?\\bvalue\\s*:\\s*)(-?\\d+(?:\\.\\d+)?(?:e-?\\d+)?)`,
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
  if (glbPath) lines.push(`GLB written: ${glbPath}`);
  return lines.join('\n');
}
