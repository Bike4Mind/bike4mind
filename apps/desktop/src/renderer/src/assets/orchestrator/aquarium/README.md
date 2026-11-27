# Orchestrator aquarium art

All art here was generated for Bike4Mind with Bike4Mind's own image models. Do not add third-party asset-pack files to this folder: this repository is public, and pack licences usually forbid redistributing raw files.

Used by the Aquarium scene (`src/renderer/src/chat/orchestrator/aquarium`). Fish: 1 coral-red round fish, 2 teal long-finned fish, 3 yellow spotted fish, 4 lavender veil-tailed fish, each in five poses: `swim` (side view, facing right), `front` (facing the viewer), `rest`, `sleep` (eyes closed) and `pale` (faded and tilted). Sprites are 160x160 transparent canvases at one shared scale with the fish's lowest point at bottom center. Render them with `image-rendering: pixelated`. A tank with more than four fish tints the extra ones with a hue rotation (each sheet's `hue` in `aquarium/aquariumArt.ts`), so it needs no extra sheets.

`backdrop.png` is the empty tank: plants and rocks kept to the outer sixth on each side, open water in the middle and a flat sand bed along the bottom fifth. The scene's map places fish by percent of the scene box in `aquarium/aquariumScene.ts`; regenerating the backdrop means re-checking the zones there (midwater, glass, low, sand), the Keeper's rock and the task slate in the same change.

`keeper-{idle,writing,reading,walking,cheering}.svg` are the Keeper, the tank's octopus host, one per host pose. They are drawn in code by `apps/desktop/scripts/orchestrator-art/keeper.mjs` (32x32 pixel grid, feet at bottom center); edit the script and rerun `node keeper.mjs` from that folder rather than editing the SVGs.

## Provenance

The prompt id names a file in `apps/desktop/scripts/orchestrator-art/prompts/`; the full prompt per output file is in `apps/desktop/scripts/orchestrator-art/prompts.json` under the `aquarium/` keys. The 20 fish sprites come from one 4x5 sheet render (2048x1648, transparent background) so their style and scale match, sliced at a fitted scale of 0.376.

| File                   | Model                    | Prompt id (sheet cell)                                                      | Generated  |
| ---------------------- | ------------------------ | --------------------------------------------------------------------------- | ---------- |
| `backdrop.png`         | `gpt-image-2.5-sunburst` | `aquarium-backdrop` (whole image, 2048x1152 opaque, downscaled to 1280x720) | 2026-11-16 |
| `fish-{1-4}-swim.png`  | `gpt-image-2.5-sunburst` | `fish-sheet` (rows 1-4, column 1)                                           | 2026-11-16 |
| `fish-{1-4}-front.png` | `gpt-image-2.5-sunburst` | `fish-sheet` (rows 1-4, column 2)                                           | 2026-11-16 |
| `fish-{1-4}-rest.png`  | `gpt-image-2.5-sunburst` | `fish-sheet` (rows 1-4, column 3)                                           | 2026-11-16 |
| `fish-{1-4}-sleep.png` | `gpt-image-2.5-sunburst` | `fish-sheet` (rows 1-4, column 4)                                           | 2026-11-16 |
| `fish-{1-4}-pale.png`  | `gpt-image-2.5-sunburst` | `fish-sheet` (rows 1-4, column 5)                                           | 2026-11-16 |

## Regenerating

From `apps/desktop/scripts/orchestrator-art/`, signed in as the tavern README describes (`b4m login`, or `--api-key-file <file>` with an API key that has the image-generation scope). `process.mjs` expects the backdrop as `backdrop.png` in the raw folder, so keep the aquarium's raw files in a folder of their own:

```bash
mkdir -p /tmp/aquarium-raw /tmp/aquarium-out
node gen.mjs --name backdrop --out /tmp/aquarium-raw/backdrop.png --model gpt-image-2.5-sunburst \
  --size 2048x1152 --background opaque --prompt-file prompts/aquarium-backdrop.txt
node gen.mjs --name fish-sheet --out /tmp/aquarium-raw/fish-sheet.png --model gpt-image-2.5-sunburst \
  --size 2048x1648 --background transparent --prompt-file prompts/fish-sheet.txt
node process.mjs --raw /tmp/aquarium-raw --out /tmp/aquarium-out --sheet fish-sheet --prefix fish-{row} \
  --rows 4 --poses swim,front,rest,sleep,pale --canvas 160
```

Check `/tmp/aquarium-out` before copying it here, and check that no fish reads as a character from an existing film, game or app; the first render of row 1 did, and was redrawn as the plain coral-red fish. Keep the folder under 1 MB, and update the table above and `prompts.json` when a file changes.
