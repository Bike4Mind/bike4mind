import {
  DEFAULT_MODEL_VIEWS,
  MODEL_POSES,
  MODEL_VIEWS,
  type ModelBuildReport,
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
  'revolve spins a profile drawn as [radius, height] points (x >= 0; anything at x < 0 is dropped) about the Z axis, so a',
  'turned shape (a vase, a bottle, a knob) already stands upright: do not rotate it afterwards.',
  'Match the detail to the request. For low-poly game assets keep segment counts low (6-12); for anything detailed or realistic',
  'use 48-96 segments on round parts and set `smooth: true` on them. Either way give each part its own color; the GLB keeps them as materials.',
  'Stand the model on z = 0 with its footprint centred on x = y = 0: the GLB origin is then on the floor under its middle, which is',
  'where a game engine places and rotates an asset.',
  'A part may also set `metalness` and `roughness` (0..1, glTF PBR; e.g. brass or iron 1 and 0.4, wood 0 and 0.8) and `smooth: true`',
  'to shade curved faces smoothly (a barrel, a knob) while keeping sharp edges; parts are faceted by default.',
  'Moving parts: give a part `pivot: [x, y, z]` (the point it turns about, e.g. a lid hinge, in model coordinates) and',
  '`parent: "body"` to nest it under another part. Each part becomes its own GLB node with its origin at the pivot, so a game',
  'engine can rotate it (open the lid) without touching the mesh. Model the rest pose (lid closed); names must be unique.',
  'Make it a joint with `axis: [x, y, z]` (the direction it turns about, model axes, right-hand rule) and `range: [from, to]`',
  '(degrees from the modelled pose, e.g. [0, 110]). The user gets a slider and a play button per joint, and the GLB gets an',
  'animation clip named after the part. Check the open pose with model_screenshot pose "open": if the part swings the wrong way, negate the axis.',
  "A part that slides instead (a drawer, a sliding door) adds `motion: 'slide'`: `axis` is the direction it slides along and `range`",
  'is in model units (e.g. [0, 40]); it needs no pivot.',
  'For 3D printing (the user mentions printing, a printer or an STL), units mm: the STL export unions every part into one',
  'solid at the rest pose, so touching parts fuse. A part that must move after printing needs a 0.4 mm gap to everything',
  'around it (a captive pin, a print-in-place hinge), or print it as its own file. Keep walls at least 1.2 mm and details at',
  'least 0.8 mm, keep overhangs within 45 degrees of vertical (chamfer the underside or split the model), put the largest',
  'flat face on z = 0, and say how big the print is and which parts need supports.',
  'Modelling from an image (one generate_image made, or a file the user gave you): if the purpose is unclear, ask once',
  'whether it is for printing, a game or just to look at, since that decides one solid vs coloured parts, detail and size.',
  'When you generate the image to model from, ask for a single object on a plain background, three-quarter view, even light,',
  'and save the one the user picks with save_generated_image beside the model so later edits can refer back to it.',
  'You see an image only in the reply that showed it, so look at it before you model: the save result shows it',
  'again, and in a later turn file_read the saved file. Never model from memory of an image you cannot see now.',
  'Then read it as a set of parts: estimate the overall height-to-width-to-depth ratio, list the parts with their sizes',
  'as fractions of that, and pick a real-world size (ask, or a sensible default). Build, then model_screenshot from the',
  'angle the image shows and compare: fix the largest difference in proportion first, colours last.',
  'CSG builds hard-surface shapes well; an organic subject (a creature, a person, a plant) comes out stylised, so say',
  'that before you start rather than after.',
].join('\n');

function requireModel(context: ToolContext): ModelContext {
  if (!context.model) throw new Error('The 3D model pane is not available in this session.');
  return context.model;
}

async function resolveModelPath(requested: string, context: ToolContext): Promise<string> {
  const path = await resolveWithinRoots(requested, context.roots, context.workingDirectory);
  if (!modelKindFor(path)) throw new Error(`Not a model file: ${requested}. Use a .model.js, .glb or .stl file.`);
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

/**
 * The pane is app-wide, so another session or the user can open a different file while this one
 * waits; anything read back after an await is checked against the path this call settled on.
 */
function assertStillOpen(model: ModelContext, path: string): void {
  if (model.view.current().path !== path)
    throw new Error('The model pane switched to another file while this was running. Call again with your path.');
}

/** Opens `path` unless it is already the open model, then waits for its current build. */
async function openAndBuild(
  model: ModelContext,
  requested: string | undefined,
  context: ToolContext
): Promise<{ report: ModelBuildReport; path: string }> {
  let path: string;
  if (requested) {
    path = await resolveModelPath(requested, context);
    if (model.view.current().path !== path) await model.view.open(path);
  } else {
    const open = model.view.current().path;
    if (!open) throw new Error('No model is open. Pass the path of a .model.js file.');
    // Without a path, only act on the open model when it sits inside this session's folders: it
    // may be another project's, or one the user picked anywhere.
    const inside = await resolveWithinRoots(open, context.roots, context.workingDirectory).then(
      () => true,
      () => false
    );
    if (!inside)
      throw new Error(
        "The model open in the pane is outside this session's folders. Pass the path of your model file."
      );
    path = open;
  }
  assertStillOpen(model, path);
  const report = await model.view.waitForBuild();
  assertStillOpen(model, path);
  return { report, path };
}

export const modelView: ToolDefinition = {
  schema: {
    name: 'model_view',
    description: [
      'Open a 3D model in the live model pane beside the chat and build it. The pane re-renders on every save of the file,',
      'and every good build of a .model.js also writes <name>.glb beside it (metres, per-part materials) for game engines.',
      'Returns the build result: size, parts, triangle count and params, or the error with its line so you can fix it.',
      'Create the file first with the file tools, then call this. Also opens existing .glb and .stl files to look at.',
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
    const { report, path } = await openAndBuild(model, requireString(input, 'path'), context);
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
          description: 'rest (default) shows the model as written; open moves every joint to the end of its range.',
        },
      },
    },
  },
  async run(input, context) {
    const model = requireModel(context);
    const views = parseViews(input);
    const pose = parsePose(input);
    const requested = typeof input.path === 'string' && input.path.trim() ? input.path.trim() : undefined;
    const { report, path } = await openAndBuild(model, requested, context);
    // The open model is app-wide, so without a path it may be another session's or the user's own pick.
    const which = requested ? '' : `No path given; used the model open in the pane: ${path}\n`;
    if (!report.ok) return `${which}${formatModelSummary(report)}`;
    const png = Buffer.from(await model.view.capture(views, pose));
    assertStillOpen(model, path);
    const name = path.split(/[\\/]/).pop() ?? 'model';
    const shownAs = pose === 'open' ? `${views.join(', ')}, joints open` : views.join(', ');
    const kept = await model.keepScreenshot(png, `${name}: ${shownAs}`);
    if (kept) context.report?.media(kept);
    context.report?.label(`Looked at ${name}`);
    const shown = showImage(context, png, 'image/png');
    const described = `Rendered ${name} from ${shownAs} (one tile per view, labelled).`;
    if (!shown.ok)
      return `${which}${described} The user sees it, but you cannot: ${shown.reason}.\n${formatModelSummary(report)}`;
    return `${which}${described} You see it below this result in this reply only.\n${formatModelSummary(report)}`;
  },
};

export const MODEL_TOOLS: readonly ToolDefinition[] = [modelView, modelScreenshot];
