# Orchestrator tavern art

All art here was generated for Bike4Mind with Bike4Mind's own image models. Do not add third-party asset-pack files to this folder: this repository is public, and pack licences usually forbid redistributing raw files.

Used by the Tavern view (`src/renderer/src/chat/orchestrator/tavern`). Characters: 1 dwarf smith, 2 elf scholar, 3 human ranger, 4 gnome tinkerer. Sprites are 256x256 transparent canvases at one shared scale with the feet at bottom center; the `work` poses include their prop, and the `ko` poses include their stars. Render them with `image-rendering: pixelated`.

The slot coordinates in `tavern/scene.ts` (`TAVERN_SLOTS`, `DOOR_POINT`) are picked for this `backdrop.png`; re-pick them whenever the backdrop is regenerated.

## Provenance

The prompt id names a file in `apps/desktop/scripts/orchestrator-art/prompts/`; the full prompt per output file is in `apps/desktop/scripts/orchestrator-art/prompts.json`. All 20 sprites come from one 4x5 sheet render (2048x1648, transparent background) so their style and scale match.

| File | Model | Prompt id (sheet cell) | Generated |
|------|-------|------------------------|-----------|
| `backdrop.png` | `gpt-image-2.5-sunburst` | `backdrop` (whole image, 2048x1152 opaque, downscaled to 1280x720) | 2026-10-30 |
| `char-1-work.png` | `gpt-image-2.5-sunburst` | `sheet-all` (row 1, column 1) | 2026-10-30 |
| `char-1-call.png` | `gpt-image-2.5-sunburst` | `sheet-all` (row 1, column 2) | 2026-10-30 |
| `char-1-rest.png` | `gpt-image-2.5-sunburst` | `sheet-all` (row 1, column 3) | 2026-10-30 |
| `char-1-ko.png` | `gpt-image-2.5-sunburst` | `sheet-all` (row 1, column 4) | 2026-10-30 |
| `char-1-idle.png` | `gpt-image-2.5-sunburst` | `sheet-all` (row 1, column 5) | 2026-10-30 |
| `char-2-work.png` | `gpt-image-2.5-sunburst` | `sheet-all` (row 2, column 1) | 2026-10-30 |
| `char-2-call.png` | `gpt-image-2.5-sunburst` | `sheet-all` (row 2, column 2) | 2026-10-30 |
| `char-2-rest.png` | `gpt-image-2.5-sunburst` | `sheet-all` (row 2, column 3) | 2026-10-30 |
| `char-2-ko.png` | `gpt-image-2.5-sunburst` | `sheet-all` (row 2, column 4) | 2026-10-30 |
| `char-2-idle.png` | `gpt-image-2.5-sunburst` | `sheet-all` (row 2, column 5) | 2026-10-30 |
| `char-3-work.png` | `gpt-image-2.5-sunburst` | `sheet-all` (row 3, column 1) | 2026-10-30 |
| `char-3-call.png` | `gpt-image-2.5-sunburst` | `sheet-all` (row 3, column 2) | 2026-10-30 |
| `char-3-rest.png` | `gpt-image-2.5-sunburst` | `sheet-all` (row 3, column 3) | 2026-10-30 |
| `char-3-ko.png` | `gpt-image-2.5-sunburst` | `sheet-all` (row 3, column 4) | 2026-10-30 |
| `char-3-idle.png` | `gpt-image-2.5-sunburst` | `sheet-all` (row 3, column 5) | 2026-10-30 |
| `char-4-work.png` | `gpt-image-2.5-sunburst` | `sheet-all` (row 4, column 1) | 2026-10-30 |
| `char-4-call.png` | `gpt-image-2.5-sunburst` | `sheet-all` (row 4, column 2) | 2026-10-30 |
| `char-4-rest.png` | `gpt-image-2.5-sunburst` | `sheet-all` (row 4, column 3) | 2026-10-30 |
| `char-4-ko.png` | `gpt-image-2.5-sunburst` | `sheet-all` (row 4, column 4) | 2026-10-30 |
| `char-4-idle.png` | `gpt-image-2.5-sunburst` | `sheet-all` (row 4, column 5) | 2026-10-30 |

## Regenerating

From `apps/desktop/scripts/orchestrator-art/`, signed in with the Bike4Mind CLI (`b4m login`; the script reads and refreshes that session and never prints the token). The API origin comes from `--api-url`, `B4M_API_URL`, or the CLI's configured custom URL:

```bash
mkdir -p /tmp/tavern-raw
node gen.mjs --name backdrop --out /tmp/tavern-raw/backdrop.png --model gpt-image-2.5-sunburst \
  --size 2048x1152 --background opaque --prompt-file prompts/backdrop.txt
node gen.mjs --name sheet-all --out /tmp/tavern-raw/sheet-all.png --model gpt-image-2.5-sunburst \
  --size 2048x1648 --background transparent --prompt-file prompts/sheet-all.txt
node process.mjs --raw /tmp/tavern-raw
```

`process.mjs` slices the sheet into the 20 sprites, binarizes alpha, resizes nearest-neighbour onto 256px canvases and writes palette PNGs (backdrop 1280x720) into this folder. It borrows `sharp` from the `packages/cli` workspace, so run `pnpm install` first. Keep the folder under 3 MB, and update the table above and `prompts.json` when a file changes.
