import { z } from 'zod';
import { FINALE_LOOKS } from '../FinaleBanner';

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
const text = z.string().min(1);
const size = z.number().positive().max(100);
// A box of no size would let a definition hide the feature it holds (the quest board).
const box = z.object({ left: percent, top: percent, width: size, height: size });

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

/** The framework's light looks; SceneLight.tsx draws each. A `lamp` is electric: steady, with no flicker. */
export const LIGHT_KINDS = ['fire', 'candle', 'lamp'] as const;
export type LightKind = (typeof LIGHT_KINDS)[number];
/** A lamp's colour: `white` (office tubes) or `blue` (a tank's hood light, whose pool stays blue at night). */
export const LAMP_TONES = ['white', 'blue'] as const;
export type LampTone = (typeof LAMP_TONES)[number];

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
  /** Where newcomers walk in from during the intro, and where an agent first seen mid-run enters. */
  door: point,
  board: box.extend({ notes: z.number().int().min(2) }),
  /** Where the host stands when it is not visiting an agent. */
  host: point,
  /**
   * Where the host's reply bubble hangs: `right` is its right edge as a percent of the scene width from the
   * right, for a host to the right of it; `left` its left edge from the left, for a host to the left of it.
   */
  reply: z.union([z.object({ top: percent, right: percent }), z.object({ top: percent, left: percent })]),
  /**
   * Furniture drawn in the backdrop that a sprite can stand behind (a counter): from `top` down to `front`
   * between `left` and `right`, the part of the sprite below `top` is cut away.
   */
  occluders: z.array(z.object({ left: percent, right: percent, top: percent, front: percent })),
  lights: z.array(
    z.object({
      x: percent,
      y: percent,
      /** Glow radius, in percent of the scene width. */
      size: z.number().positive(),
      kind: z.enum(LIGHT_KINDS),
      /** A `lamp`'s colour; `white` if unset. Other kinds ignore it. */
      tone: z.enum(LAMP_TONES).optional(),
    })
  ),
  /** Where moonlight falls at night, if the room has a window. */
  moon: point.optional(),
  /** Where embers rise from, if the room has a fire. */
  embers: point.optional(),
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
        /** Degrees of hue rotation over the art, so one drawing can make several looks. */
        hue: z.number().min(0).max(360).optional(),
        sprites: z.record(name, asset),
      })
    )
    .min(1),
  /** Where a sprite's face sits on its canvas, percent from the top; the overflow token centres on it. */
  faceY: percent.optional(),
  /** Poses that swim back and forth `reach` percent of the scene width either side of the seat, facing the way they go. */
  roam: z.object({ poses: z.array(name).min(1), reach: z.number().positive().max(50) }).optional(),
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
    states: z.object({
      zone: byState(name),
      pose: byState(name),
      /** Where a working agent waits while its workspace is still being set up; its working zone if unset. */
      preparing: name.optional(),
    }),
    ambience: z.object({
      /** Behind the letterboxed picture. */
      frame: z.string().min(1),
      /** Behind the backdrop while it loads. */
      floor: z.string().min(1),
      /** The quiet room's slow camera once the chrome has settled. */
      settledDrift: z.boolean(),
      /** The glow the settled picture throws into the letterbox around it. */
      settledShadow: z.string().min(1),
      /** A wash over the backdrop, under the light and sprites, for a scene kept low in contrast. */
      veil: z.string().min(1).optional(),
      /** Keeps animating while the window is unfocused (never while hidden): a scene meant for a second monitor. */
      awakeUnfocused: z.boolean().optional(),
    }),
    look: z.object({
      /** Name plates and the board's frame. */
      plate: z.object({ background: z.string().min(1), edge: z.string().min(1), ink: z.string().min(1) }),
      /** How the stage dresses the finale banner over this scene (FinaleBanner.tsx). */
      finale: z.enum(FINALE_LOOKS),
    }),
    copy: z.object({
      /** The scene's accessible name, e.g. "Tavern". */
      name: z.string().min(1),
      hostName: z.string().min(1),
      /** Completes the host's tooltip, "<hostName>: <hostTitle>". */
      hostTitle: z.string().min(1),
      /** What the host says when nothing else is on its mind. */
      hostGreeting: z.string().min(1),
      /** What the host is doing in each pose, for its accessible name. */
      hostPoses: z.object({ idle: text, writing: text, reading: text, walking: text, cheering: text }),
      board: z.object({
        title: text,
        /** The board's accessible name, e.g. "Quest board". */
        name: text,
        item: text,
        items: text,
        empty: text,
      }),
      /** Lines the stage and shell say about this scene. */
      stage: z.object({
        /** Names the parent on the settled Needs-you card, e.g. "The Innkeeper". */
        host: text,
        quiet: text,
        talk: text,
        /** Under the empty scene, before any agent has started. */
        empty: text,
        /** Under the empty scene once every agent of the run has been archived. */
        emptyArchived: text,
        /** The finale card's title when every agent finished done, and otherwise. */
        finale: z.object({ complete: text, ended: text }),
      }),
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
    if (scene.states.preparing !== undefined && !zones.has(scene.states.preparing)) {
      issue(['states', 'preparing'], `unknown zone "${scene.states.preparing}"`);
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
    scene.cast.roam?.poses.forEach((pose, index) => {
      if (!poses.has(pose)) issue(['cast', 'roam', 'poses', index], `unknown pose "${pose}"`);
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
