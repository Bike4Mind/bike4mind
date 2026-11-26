import { z } from 'zod';

/**
 * A scene as data: the map, the cast, which zone and pose each agent state takes, the ambience and the copy.
 * SceneStage draws any definition that passes `sceneDefinitionSchema`; placement (placement.ts) reads only
 * the zone names a definition declares. Coordinates are percent of the scene box, feet at the point.
 */
export const SCENE_DEFINITION_VERSION = 1;

const percent = z.number().min(0).max(100);
const point = z.object({ x: percent, y: percent });
const name = z.string().regex(/^[a-z][a-z0-9-]*$/, 'lower-case kebab name');
const asset = z.string().min(1);
const box = z.object({ left: percent, top: percent, width: percent, height: percent });

// Keyed by every AgentState; sceneDefinition.test.ts holds this list to AGENT_STATE_LABEL's keys.
const byState = <T extends z.ZodType>(value: T) =>
  z.object({
    'needs-you': value,
    working: value,
    waiting: value,
    done: value,
    failed: value,
    paused: value,
    stopped: value,
    idle: value,
  });

export const HOST_POSES = ['idle', 'writing', 'reading', 'walking', 'cheering'] as const;
export type HostPose = (typeof HOST_POSES)[number];

const EPITHETS = ['Warden', 'Scribe', 'Tinkerer', 'Cartographer', 'Seeker', 'Wanderer'] as const;

const zoneSchema = z.object({
  slots: z.array(point).min(1),
  /** Where the zone stacks the agents it has no seat for. */
  overflow: point,
  /** Completes "3 more ..." for the zone's overflow stack, e.g. "at the bar". */
  place: z.string().min(1),
});

const mapSchema = z.object({
  /** Width over height of the backdrop, which the scene box keeps at every size. */
  aspect: z.object({ width: z.number().positive(), height: z.number().positive() }),
  backdrop: asset,
  zones: z.record(name, zoneSchema),
  /** Where a needs-you agent borrows a seat once its own zone is full, most preferred first. */
  borrowOrder: z.array(name),
  door: point,
  board: box.extend({ notes: z.number().int().min(2) }),
  host: point,
  lights: z.array(
    z.object({
      x: percent,
      y: percent,
      /** Glow radius, in percent of the scene width. */
      size: z.number().positive(),
      color: z.string().min(1),
      flicker: z.boolean(),
    })
  ),
});

const castSchema = z.object({
  /** Sprite height as a percent of the scene height; sprite canvases are square. */
  spriteHeight: z.number().positive().max(100),
  poses: z.array(name).min(1),
  /** Poses that bob while held, frozen under reduced motion and pause. */
  animatedPoses: z.array(name),
  sheets: z
    .array(
      z.object({
        look: z.string().min(1),
        /** The kind of work this character looks the part for; such agents get it first. */
        craft: z.enum(EPITHETS).optional(),
        sprites: z.record(name, asset),
      })
    )
    .min(1),
  host: z.object({
    sprites: z.object({ idle: asset, writing: asset, reading: asset, walking: asset, cheering: asset }),
  }),
});

export const sceneDefinitionSchema = z
  .object({
    version: z.literal(SCENE_DEFINITION_VERSION),
    id: name,
    map: mapSchema,
    cast: castSchema,
    states: z.object({ zone: byState(name), pose: byState(name) }),
    ambience: z.object({
      /** Behind the letterboxed picture. */
      frame: z.string().min(1),
      /** Behind the backdrop while it loads. */
      floor: z.string().min(1),
      /** The quiet room's slow camera once the chrome has settled. */
      settledDrift: z.boolean(),
    }),
    copy: z.object({
      /** The scene's accessible name, e.g. "Tavern". */
      name: z.string().min(1),
      hostName: z.string().min(1),
      hostTitle: z.string().min(1),
      boardTitle: z.string().min(1),
    }),
  })
  .superRefine((scene, context) => {
    const issue = (path: (string | number)[], message: string) => context.addIssue({ code: 'custom', path, message });
    const zones = new Set(Object.keys(scene.map.zones));
    const poses = new Set(scene.cast.poses);
    if (zones.size === 0) issue(['map', 'zones'], 'a scene needs at least one zone');
    for (const [state, zone] of Object.entries(scene.states.zone)) {
      if (!zones.has(zone)) issue(['states', 'zone', state], `unknown zone "${zone}"`);
    }
    for (const [state, pose] of Object.entries(scene.states.pose)) {
      if (!poses.has(pose)) issue(['states', 'pose', state], `unknown pose "${pose}"`);
    }
    scene.map.borrowOrder.forEach((zone, index) => {
      if (!zones.has(zone)) issue(['map', 'borrowOrder', index], `unknown zone "${zone}"`);
    });
    scene.cast.animatedPoses.forEach((pose, index) => {
      if (!poses.has(pose)) issue(['cast', 'animatedPoses', index], `unknown pose "${pose}"`);
    });
    scene.cast.sheets.forEach((sheet, index) => {
      for (const pose of poses) {
        if (!sheet.sprites[pose]) issue(['cast', 'sheets', index, 'sprites', pose], `missing pose "${pose}"`);
      }
    });
  });

export type SceneDefinition = z.infer<typeof sceneDefinitionSchema>;
export type ScenePoint = z.infer<typeof point>;
export type SceneZone = z.infer<typeof zoneSchema>;

/** Parses untrusted scene data; throws a readable error naming every bad field. */
export function parseSceneDefinition(input: unknown): SceneDefinition {
  const result = sceneDefinitionSchema.safeParse(input);
  if (!result.success) throw new Error(`Invalid scene definition: ${z.prettifyError(result.error)}`);
  return result.data;
}
