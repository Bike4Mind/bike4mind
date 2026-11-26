# Scene framework

Every Orchestrate scene (Tavern, Office, Aquarium, ...) is drawn by one component, `SceneStage`, from a
`SceneDefinition` (`sceneDefinition.ts`). A scene is data: its map, sprites, sprite positions, look and
copy. It has no code of its own, so every scene has the same features and UX, and a fix to the framework
fixes every scene.

## Adding a scene: definition + assets only

1. **Assets.** Put the backdrop and sprite sheets under `src/renderer/src/assets/orchestrator/<id>/`.
   Every cast sheet needs a sprite for every pose the definition names; the host needs `idle`, `writing`,
   `reading`, `walking` and `cheering`.
2. **Definition.** Add `orchestrator/<id>/<id>Scene.ts` exporting a `SceneDefinition` (see
   `tavern/tavernScene.ts`, `office/officeScene.ts`, `aquarium/aquariumScene.ts`). It declares:
   - `map`: aspect, backdrop, zones (seats, overflow point, the "3 more ..." place), `borrowOrder`, door,
     board, host spot, reply anchor, occluders and lights;
   - `cast`: sprite height, poses, sheets and the host's sprites;
   - `states`: the zone and pose for each agent state;
   - `ambience`, `look` and `copy`: colours, the finale look, and every line the scene says.

   `id` must equal the view id: test ids are `orchestrator-<id>-...`. Parse it in a test with
   `parseSceneDefinition` so a bad map fails CI, not the chat screen.

3. **Register it.** Three lines of wiring, no feature code:
   - add the id to `OrchestratorViewId` and `ORCHESTRATOR_VIEWS` (`orchestratorViews.ts`);
   - add `sceneView(<ID>_SCENE)` to `ORCHESTRATOR_VIEW_COMPONENTS` (`viewRegistry.tsx`);
   - add its menu entry to `ORCHESTRATOR_VIEW_INFO` (`ViewSwitcher.tsx`) with `group: 'scene'` and
     `scene: frameworkScene(<ID>_SCENE)`.

That is all. Do not branch on the scene id anywhere: the stage and shell read capability flags
(`SceneStageInfo`), and a scene's differences live in its definition. If a scene needs something the
schema cannot say, extend the schema and `SceneStage` so every scene can use it.

## Skins: a `scenes.<id>` block per scene

A skin (contract 2, `tokens.json`, shape in `sceneSkinSchema` in `src/shared/mods.ts`) restyles a scene
the same way a scene is made: data only. Its `scenes` map holds one optional block per scene id, and each
block may override part of that scene's definition:

- `backdrop`: an image in the skin folder;
- `cast`: sprite height, face line, the cast sheets (a list replaces the scene's), and some of the
  host's sprites;
- `map`: a zone's seats, overflow point and place, the door, host spot, board, reply anchor (replaces),
  lights (replace), moon and embers;
- `copy`: any of the scene's lines, including the stage lines and the finale title.

States, aspect, occluders, ambience and look are not skinnable. `sceneSkin.ts` (`skinScene`,
`useSkinnedScene`) is the only place a block meets a definition: objects merge key by key, lists replace,
and the result is parsed with `sceneDefinitionSchema`. A block that breaks the scene is dropped whole,
with one `SKINS:` warning, and the scene draws as it ships. So a skin, like a scene, can change how a
feature looks and where it sits but never remove it. Stage copy and finale art follow the skin through
`useSceneStageInfo` / `useSceneStageCopy` (`ViewSwitcher.tsx`). The sample skin is
`src/shared/__fixtures__/skins/nightglass`.

## The parity guard

These run against every view in group `scene`, read from the registry, so a new scene is checked
without touching them:

- `sceneParity.test.tsx`: the feature suite, run for each scene bare and under the nightglass skin, with
  every expectation read off the definition as the skin draws it. Needs-you bubble and inline answers,
  dialogue queue, opening a waiting agent from its "Needs you!" marker when the box has nothing to ask,
  the ask bubble (the request, and its waiting, approved, denied and answered-elsewhere states), quest
  board, overflow and its keyboard menu, host and reply bubble, PR indicator, details on select, finale
  host and title, settled ambience, intro walk, pause (and `awakeUnfocused`), reduced motion, keyboard and
  `aria-pressed`, live region and summary, sticky seats, one-word names, and hundreds of agents.
- `sceneRegistry.test.ts`: each scene view is a `sceneView` built from a valid definition whose id is the
  view id, with no feature switched off, and its menu info comes from the same definition. It also fails
  on a `view === '<scene id>'` check anywhere in the renderer.
- `placementParity.test.ts`: each map places seeded random roster histories deterministically and
  stickily.
