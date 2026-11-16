# Orchestrator tavern art

All art here was generated for Bike4Mind with Bike4Mind's own image models. Do not add third-party asset-pack files to this folder: this repository is public, and pack licences usually forbid redistributing raw files.

Used by the Tavern view (`src/renderer/src/chat/orchestrator/tavern`). Characters: 1 dwarf smith, 2 elf scholar, 3 human ranger, 4 gnome tinkerer, 5 halfling bard, 6 orc alchemist, 7 human knight, 8 cat-folk cartographer (each listed with its craft in `tavern/tavernArt.ts`; add a sheet there too when adding one here), plus the Innkeeper (`innkeeper-*.png`, poses `idle`, `writing`, `reading`, `walking`, `cheering`). Sprites are 256x256 transparent canvases at one shared scale with the feet at bottom center; the `work` poses include their prop, and the `ko` poses include their stars. Render them with `image-rendering: pixelated`.

Everything placed on `backdrop.png` lives in `layout.json` beside it: the seats per zone, where a full zone stacks its extra agents, the door, the Innkeeper's spot, the bar counter, the lamps, the window and the hearth glow. All are percents of the scene box (0-100). Regenerating the backdrop means re-picking `layout.json` in the same change; `tavern/tavernLayout.ts` parses it at load and `tavern/scene.test.ts` checks that every zone has slots inside the scene.

## Provenance

The prompt id names a file in `apps/desktop/scripts/orchestrator-art/prompts/`; the full prompt per output file is in `apps/desktop/scripts/orchestrator-art/prompts.json`. The `char-1-*` to `char-4-*` sprites come from one 4x5 sheet render (2048x1648, transparent background) so their style and scale match; `char-5-*` to `char-8-*` come from a second sheet with the same layout and pose lines (`sheet-cast-2`), sliced at its own fitted scale, which lands the idle poses at 187-221px against 205-225px for the first four. The 5 Innkeeper sprites come from their own 1x5 sheet (2048x1152, transparent background), sliced at a fixed scale of 0.4 so the idle pose stands 218px tall, in the range of the `char-*` idle poses.

| File                     | Model                    | Prompt id (sheet cell)                                             | Generated  |
| ------------------------ | ------------------------ | ------------------------------------------------------------------ | ---------- |
| `backdrop.png`           | `gpt-image-2.5-sunburst` | `backdrop` (whole image, 2048x1152 opaque, downscaled to 1280x720) | 2026-10-30 |
| `char-1-work.png`        | `gpt-image-2.5-sunburst` | `sheet-all` (row 1, column 1)                                      | 2026-10-30 |
| `char-1-call.png`        | `gpt-image-2.5-sunburst` | `sheet-all` (row 1, column 2)                                      | 2026-10-30 |
| `char-1-rest.png`        | `gpt-image-2.5-sunburst` | `sheet-all` (row 1, column 3)                                      | 2026-10-30 |
| `char-1-ko.png`          | `gpt-image-2.5-sunburst` | `sheet-all` (row 1, column 4)                                      | 2026-10-30 |
| `char-1-idle.png`        | `gpt-image-2.5-sunburst` | `sheet-all` (row 1, column 5)                                      | 2026-10-30 |
| `char-2-work.png`        | `gpt-image-2.5-sunburst` | `sheet-all` (row 2, column 1)                                      | 2026-10-30 |
| `char-2-call.png`        | `gpt-image-2.5-sunburst` | `sheet-all` (row 2, column 2)                                      | 2026-10-30 |
| `char-2-rest.png`        | `gpt-image-2.5-sunburst` | `sheet-all` (row 2, column 3)                                      | 2026-10-30 |
| `char-2-ko.png`          | `gpt-image-2.5-sunburst` | `sheet-all` (row 2, column 4)                                      | 2026-10-30 |
| `char-2-idle.png`        | `gpt-image-2.5-sunburst` | `sheet-all` (row 2, column 5)                                      | 2026-10-30 |
| `char-3-work.png`        | `gpt-image-2.5-sunburst` | `sheet-all` (row 3, column 1)                                      | 2026-10-30 |
| `char-3-call.png`        | `gpt-image-2.5-sunburst` | `sheet-all` (row 3, column 2)                                      | 2026-10-30 |
| `char-3-rest.png`        | `gpt-image-2.5-sunburst` | `sheet-all` (row 3, column 3)                                      | 2026-10-30 |
| `char-3-ko.png`          | `gpt-image-2.5-sunburst` | `sheet-all` (row 3, column 4)                                      | 2026-10-30 |
| `char-3-idle.png`        | `gpt-image-2.5-sunburst` | `sheet-all` (row 3, column 5)                                      | 2026-10-30 |
| `char-4-work.png`        | `gpt-image-2.5-sunburst` | `sheet-all` (row 4, column 1)                                      | 2026-10-30 |
| `char-4-call.png`        | `gpt-image-2.5-sunburst` | `sheet-all` (row 4, column 2)                                      | 2026-10-30 |
| `char-4-rest.png`        | `gpt-image-2.5-sunburst` | `sheet-all` (row 4, column 3)                                      | 2026-10-30 |
| `char-4-ko.png`          | `gpt-image-2.5-sunburst` | `sheet-all` (row 4, column 4)                                      | 2026-10-30 |
| `char-4-idle.png`        | `gpt-image-2.5-sunburst` | `sheet-all` (row 4, column 5)                                      | 2026-10-30 |
| `char-5-work.png`        | `gpt-image-2.5-sunburst` | `sheet-cast-2` (row 1, column 1)                                   | 2026-11-09 |
| `char-5-call.png`        | `gpt-image-2.5-sunburst` | `sheet-cast-2` (row 1, column 2)                                   | 2026-11-09 |
| `char-5-rest.png`        | `gpt-image-2.5-sunburst` | `sheet-cast-2` (row 1, column 3)                                   | 2026-11-09 |
| `char-5-ko.png`          | `gpt-image-2.5-sunburst` | `sheet-cast-2` (row 1, column 4)                                   | 2026-11-09 |
| `char-5-idle.png`        | `gpt-image-2.5-sunburst` | `sheet-cast-2` (row 1, column 5)                                   | 2026-11-09 |
| `char-6-work.png`        | `gpt-image-2.5-sunburst` | `sheet-cast-2` (row 2, column 1)                                   | 2026-11-09 |
| `char-6-call.png`        | `gpt-image-2.5-sunburst` | `sheet-cast-2` (row 2, column 2)                                   | 2026-11-09 |
| `char-6-rest.png`        | `gpt-image-2.5-sunburst` | `sheet-cast-2` (row 2, column 3)                                   | 2026-11-09 |
| `char-6-ko.png`          | `gpt-image-2.5-sunburst` | `sheet-cast-2` (row 2, column 4)                                   | 2026-11-09 |
| `char-6-idle.png`        | `gpt-image-2.5-sunburst` | `sheet-cast-2` (row 2, column 5)                                   | 2026-11-09 |
| `char-7-work.png`        | `gpt-image-2.5-sunburst` | `sheet-cast-2` (row 3, column 1)                                   | 2026-11-09 |
| `char-7-call.png`        | `gpt-image-2.5-sunburst` | `sheet-cast-2` (row 3, column 2)                                   | 2026-11-09 |
| `char-7-rest.png`        | `gpt-image-2.5-sunburst` | `sheet-cast-2` (row 3, column 3)                                   | 2026-11-09 |
| `char-7-ko.png`          | `gpt-image-2.5-sunburst` | `sheet-cast-2` (row 3, column 4)                                   | 2026-11-09 |
| `char-7-idle.png`        | `gpt-image-2.5-sunburst` | `sheet-cast-2` (row 3, column 5)                                   | 2026-11-09 |
| `char-8-work.png`        | `gpt-image-2.5-sunburst` | `sheet-cast-2` (row 4, column 1)                                   | 2026-11-09 |
| `char-8-call.png`        | `gpt-image-2.5-sunburst` | `sheet-cast-2` (row 4, column 2)                                   | 2026-11-09 |
| `char-8-rest.png`        | `gpt-image-2.5-sunburst` | `sheet-cast-2` (row 4, column 3)                                   | 2026-11-09 |
| `char-8-ko.png`          | `gpt-image-2.5-sunburst` | `sheet-cast-2` (row 4, column 4)                                   | 2026-11-09 |
| `char-8-idle.png`        | `gpt-image-2.5-sunburst` | `sheet-cast-2` (row 4, column 5)                                   | 2026-11-09 |
| `innkeeper-idle.png`     | `gpt-image-2.5-sunburst` | `innkeeper` (column 1)                                             | 2026-11-03 |
| `innkeeper-writing.png`  | `gpt-image-2.5-sunburst` | `innkeeper` (column 2)                                             | 2026-11-03 |
| `innkeeper-reading.png`  | `gpt-image-2.5-sunburst` | `innkeeper` (column 3)                                             | 2026-11-03 |
| `innkeeper-walking.png`  | `gpt-image-2.5-sunburst` | `innkeeper` (column 4)                                             | 2026-11-03 |
| `innkeeper-cheering.png` | `gpt-image-2.5-sunburst` | `innkeeper` (column 5)                                             | 2026-11-03 |

## Regenerating

From `apps/desktop/scripts/orchestrator-art/`, signed in with the Bike4Mind CLI (`b4m login`; the script only reads that session, never refreshes or rewrites it, and never prints the token - if the token has expired, run `b4m login` again and retry). The API origin comes from `--api-url`, `B4M_API_URL`, or the CLI's configured custom URL:

```bash
mkdir -p /tmp/tavern-raw
node gen.mjs --name backdrop --out /tmp/tavern-raw/backdrop.png --model gpt-image-2.5-sunburst \
  --size 2048x1152 --background opaque --prompt-file prompts/backdrop.txt
node gen.mjs --name sheet-all --out /tmp/tavern-raw/sheet-all.png --model gpt-image-2.5-sunburst \
  --size 2048x1648 --background transparent --prompt-file prompts/sheet-all.txt
node process.mjs --raw /tmp/tavern-raw
node gen.mjs --name sheet-cast-2 --out /tmp/tavern-raw/sheet-cast-2.png --model gpt-image-2.5-sunburst \
  --size 2048x1648 --background transparent --prompt-file prompts/sheet-cast-2.txt
node process.mjs --raw /tmp/tavern-raw --sheet sheet-cast-2 --first-row 5 --no-backdrop
node gen.mjs --name innkeeper --out /tmp/tavern-raw/innkeeper.png --model gpt-image-2.5-sunburst \
  --size 2048x1152 --background transparent --prompt-file prompts/innkeeper.txt
node process.mjs --raw /tmp/tavern-raw --sheet innkeeper --prefix innkeeper --rows 1 \
  --poses idle,writing,reading,walking,cheering --scale 0.4 --no-backdrop
```

Instead of the CLI session, `--api-key-file <file>` (or `B4M_API_KEY_FILE`) sends an API key with the image-generation scope read from that file. Before writing into this folder, run `process.mjs` with `--out` pointing at a scratch folder and check the result: re-pick `--scale` from a scratch run so the new idle pose matches the existing ones.

`process.mjs` slices the sheet into the 20 sprites, binarizes alpha, resizes nearest-neighbour onto 256px canvases and writes palette PNGs (backdrop 1280x720) into this folder. It borrows `sharp` from the `packages/cli` workspace, so run `pnpm install` first. Keep the folder under 3 MB, and update the table above and `prompts.json` when a file changes.
