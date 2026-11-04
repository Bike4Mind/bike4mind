import {
  DEFAULT_MODEL_VIEWS,
  MODEL_POSES,
  MODEL_VIEWS,
  type ModelPose,
  type ModelView,
  formatModelSummary,
  modelKindFor,
} from '@shared/model3d';
import { resolveWithinRoots } from './paths';
import { showImage } from './toolImages';
import { requireString, type ModelContext, type ToolContext, type ToolDefinition } from './types';

/**
 * The 3D model tools: open a model in the user's live pane and look at it. The agent writes and
 * edits `*.model.js` files with the ordinary file tools (and their approvals); these two only read,
 * plus the derived `<name>.glb` that ModelLiveView writes beside the model on each good build.
 */

/** The contract the build expects. Must stay in step with the engine worker in model3d/engineProtocol.ts. */
const MODEL_FILE_CONTRACT = [
  'A model is a JavaScript ES module named <name>.model.js, built with the manifold-3d CSG library.',
  'It may not import anything; `m` is the manifold module (m.Manifold, m.CrossSection) and `p` holds the param values.',
  "Optional: `export const units = 'mm'` (default) or 'm'; `export const params = { width: { value: 60, min: 20, max: 200, step: 1 } }` (the user gets a slider per param).",
  'Default export: a function returning a Manifold, or an array of { name, color, shape } parts (color as #rrggbb). Z is up.',
  'Useful calls: Manifold.cube([x,y,z], center), Manifold.cylinder(height, radiusLow, radiusHigh, segments, center), Manifold.sphere(r, segments),',
  'a.add(b), a.subtract(b), a.intersect(b), Manifold.union([..]), .translate([x,y,z]), .rotate([rx,ry,rz]) (degrees), .scale(s), .mirror([x,y,z]),',
  'Manifold.hull([..]), CrossSection.square/circle/ofPolygons(..).extrude(height) and .revolve(segments).',
  'Example: export default function model({ m, p }) { const { Manifold } = m; return [{ name: "box", color: "#8b5a2b", shape: Manifold.cube([p.width, 40, 30], true) }]; }',
  'For low-poly game assets keep segment counts low (6-12) and give each part its own color; the GLB keeps them as materials.',
  'Moving parts: give a part `pivot: [x, y, z]` (the point it turns about, e.g. a lid hinge, in model coordinates) and',
  '`parent: "body"` to nest it under another part. Each part becomes its own GLB node with its origin at the pivot, so a game',
  'engine can rotate it (open the lid) without touching the mesh. Model the rest pose (lid closed); names must be unique.',
  'Make it a joint with `axis: [x, y, z]` (the direction it turns about, model axes, right-hand rule) and `range: [from, to]`',
  '(degrees from the modelled pose, e.g. [0, 110]). The user gets a slider and a play button per joint, and the GLB gets an',
  'animation clip named after the part. Check the open pose with model_screenshot pose "open": if the part swings the wrong way, negate the axis.',
].join('\n');

function requireModel(context: ToolContext): ModelContext {
  if (!context.model) throw new Error('The 3D model pane is not available in this session.');
  return context.model;
}

async function resolveModelPath(requested: string, context: ToolContext): Promise<string> {
  const path = await resolveWithinRoots(requested, context.roots, context.workingDirectory);
  if (!modelKindFor(path))
    throw new Error(`Not a model file: ${requested}. Use a .model.js, .glb, .gltf or .stl file.`);
  return path;
}

function parsePose(input: Record<string, unknown>): ModelPose {
  const raw = input.pose ?? 'rest';
  if (!(MODEL_POSES as readonly unknown[]).includes(raw))
    throw new Error(`pose must be one of: ${MODEL_POSES.join(', ')}`);
  return raw as ModelPose;
}

function parseViews(input: Record<string, unknown>): ModelView[] {
  const raw = input.views;
  if (raw === undefined) return DEFAULT_MODEL_VIEWS;
  if (!Array.isArray(raw) || raw.length === 0)
    throw new Error(`views must be a non-empty list of: ${MODEL_VIEWS.join(', ')}`);
  const views = raw.filter((view): view is ModelView => (MODEL_VIEWS as readonly unknown[]).includes(view));
  if (views.length !== raw.length) throw new Error(`views must be a non-empty list of: ${MODEL_VIEWS.join(', ')}`);
  return [...new Set(views)].slice(0, 6);
}

/** Opens `path` unless it is already the open model, then waits for its current build. */
async function openAndBuild(model: ModelContext, requested: string | undefined, context: ToolContext) {
  if (requested) {
    const path = await resolveModelPath(requested, context);
    if (model.view.current().path !== path) await model.view.open(path);
  } else if (!model.view.current().path) {
    throw new Error('No model is open. Pass the path of a .model.js file.');
  }
  return model.view.waitForBuild();
}

export const modelView: ToolDefinition = {
  schema: {
    name: 'model_view',
    description: [
      'Open a 3D model in the live model pane beside the chat and build it. The pane re-renders on every save of the file,',
      'and every good build of a .model.js also writes <name>.glb beside it (metres, per-part materials) for game engines.',
      'Returns the build result: size, parts, triangle count and params, or the error with its line so you can fix it.',
      'Create the file first with the file tools, then call this. Also opens existing .glb, .gltf and .stl files to look at.',
      'Check the result with model_screenshot before telling the user it is done.',
      '',
      MODEL_FILE_CONTRACT,
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The model file, relative to the working directory or absolute.' },
      },
      required: ['path'],
    },
  },
  async run(input, context) {
    const model = requireModel(context);
    const report = await openAndBuild(model, requireString(input, 'path'), context);
    const path = model.view.current().path ?? '';
    context.report?.label(`Showing ${path.split(/[\\/]/).pop() ?? 'model'}`);
    return formatModelSummary(report, model.view.glbPath() ?? undefined);
  },
};

export const modelScreenshot: ToolDefinition = {
  schema: {
    name: 'model_screenshot',
    description:
      'Render the open 3D model from several fixed angles into one labelled image you see and the user sees in the conversation. Use it after every change to check the shape, proportions and colors from more than one side. If the latest build failed it returns the error instead.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'A model file to open first. Omit it to use the open model.' },
        views: {
          type: 'array',
          items: { type: 'string', enum: [...MODEL_VIEWS] },
          description: `Which angles, default ${DEFAULT_MODEL_VIEWS.join(', ')}.`,
        },
        pose: {
          type: 'string',
          enum: [...MODEL_POSES],
          description: 'rest (default) shows the model as written; open turns every joint to the end of its range.',
        },
      },
    },
  },
  async run(input, context) {
    const model = requireModel(context);
    const views = parseViews(input);
    const pose = parsePose(input);
    const requested = typeof input.path === 'string' && input.path.trim() ? input.path.trim() : undefined;
    const report = await openAndBuild(model, requested, context);
    if (!report.ok) return formatModelSummary(report);
    const png = Buffer.from(await model.view.capture(views, pose));
    const name = model.view.current().path?.split(/[\\/]/).pop() ?? 'model';
    const shownAs = pose === 'open' ? `${views.join(', ')}, joints open` : views.join(', ');
    const kept = await model.keepScreenshot(png, `${name}: ${shownAs}`);
    if (kept) context.report?.media(kept);
    context.report?.label(`Looked at ${name}`);
    const shown = showImage(context, png, 'image/png');
    const described = `Rendered ${name} from ${shownAs} (one tile per view, labelled).`;
    if (!shown.ok)
      return `${described} The user sees it, but you cannot: ${shown.reason}.\n${formatModelSummary(report)}`;
    return `${described} You see it below this result in this reply only.\n${formatModelSummary(report)}`;
  },
};

export const MODEL_TOOLS: readonly ToolDefinition[] = [modelView, modelScreenshot];
