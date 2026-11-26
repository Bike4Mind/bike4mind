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

## The parity guard

These run against every view in group `scene`, read from the registry, so a new scene is checked
without touching them:

- `sceneParity.test.tsx`: the feature suite. Needs-you bubble and inline answers, dialogue queue, quest
  board, overflow and its keyboard menu, host and reply bubble, PR indicator, details on select, finale
  host and title, settled ambience, intro walk, pause (and `awakeUnfocused`), reduced motion, keyboard and
  `aria-pressed`, live region and summary, sticky seats, one-word names, and hundreds of agents.
- `sceneRegistry.test.ts`: each scene view is a `sceneView` built from a valid definition whose id is the
  view id, with no feature switched off, and its menu info comes from the same definition. It also fails
  on a `view === '<scene id>'` check anywhere in the renderer.
- `placementParity.test.ts`: each map places seeded random roster histories deterministically and
  stickily.
