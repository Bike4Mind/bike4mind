import { z } from 'zod';
import type { SceneSkin } from '@shared/mods';
import { useSkinTheme } from '../skins';
import { sceneDefinitionSchema, type SceneDefinition } from './sceneDefinition';

/**
 * The one place a skin's scene block (SkinTheme.scenes, shape in @shared/mods sceneSkinSchema) meets a
 * scene definition. The merge is validated against sceneDefinitionSchema; a block that breaks the scene is
 * dropped whole, so the scene draws as it ships, and the reason is logged once.
 */
const merged = new WeakMap<SceneDefinition, WeakMap<SceneSkin, SceneDefinition>>();

export function skinScene(
  scene: SceneDefinition,
  block: SceneSkin | undefined,
  skinId: string | null
): SceneDefinition {
  if (!block) return scene;
  let byBlock = merged.get(scene);
  if (!byBlock) {
    byBlock = new WeakMap();
    merged.set(scene, byBlock);
  }
  const cached = byBlock.get(block);
  if (cached) return cached;
  const result = sceneDefinitionSchema.safeParse(overlay(scene, block));
  if (!result.success) {
    console.warn(
      `SKINS: ${skinId ?? 'skin'}: ignoring its ${scene.id} scene, so the scene keeps its own look: ${z.prettifyError(result.error)}`
    );
  }
  const skinned = result.success ? result.data : scene;
  byBlock.set(block, skinned);
  return skinned;
}

/** The scene as the active skin draws it; the same object while neither the skin nor the scene changes. */
export function useSkinnedScene(scene: SceneDefinition): SceneDefinition {
  const theme = useSkinTheme();
  return skinScene(scene, theme.scenes[scene.id], theme.id);
}

type Plain = Record<string, unknown>;
const isPlain = (value: unknown): value is Plain =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Objects merge key by key; arrays and values replace.
function mergeDeep(base: Plain, over: Plain): Plain {
  const out: Plain = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) continue;
    const current = out[key];
    out[key] = isPlain(current) && isPlain(value) ? mergeDeep(current, value) : value;
  }
  return out;
}

function overlay(scene: SceneDefinition, block: SceneSkin): unknown {
  const { backdrop, cast = {}, map = {}, copy = {} } = block;
  // `reply` is a choice of anchors, so the skin's replaces the scene's rather than mixing a left with a right.
  const { reply, zones = {}, ...anchors } = map;
  const sceneZones: Plain = scene.map.zones;
  return {
    ...scene,
    map: {
      ...mergeDeep(scene.map, { ...anchors, zones: mergeDeep(sceneZones, zones) }),
      ...(reply ? { reply } : {}),
      ...(backdrop ? { backdrop } : {}),
    },
    cast: mergeDeep(scene.cast, cast),
    copy: mergeDeep(scene.copy, copy),
  };
}
