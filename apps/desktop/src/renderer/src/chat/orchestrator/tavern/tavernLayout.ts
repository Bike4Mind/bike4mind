import { z } from 'zod';
import layoutJson from '../../../assets/orchestrator/tavern/layout.json';

/**
 * Where things stand in backdrop.png, read from the layout.json kept beside the art so a regenerated
 * backdrop ships with its own coordinates. The schema is enforced by scene.test.ts against the shipped
 * file rather than at load, so a bad file fails CI instead of the chat screen.
 */
const percent = z.number().min(0).max(100);
const point = z.object({ x: percent, y: percent });
const seats = z.array(point).min(1);
const zones = <T extends z.ZodType>(value: T) =>
  z.object({ workbench: value, bar: value, hearth: value, benches: value });

export const tavernLayoutSchema = z.object({
  slots: zones(seats),
  overflow: zones(point),
  door: point,
  /** The quest board hung on the back wall: its box, and how many notes fit pinned on it. */
  questBoard: z.object({
    left: percent,
    top: percent,
    width: percent,
    height: percent,
    notes: z.number().int().min(2),
  }),
  innkeeper: point,
  barCounter: z.object({ left: percent, right: percent, top: percent, front: percent }),
  lights: z.array(
    z.object({
      x: percent,
      y: percent,
      /** Glow radius, in percent of the scene width. */
      size: z.number().positive(),
      kind: z.enum(['fire', 'candle']),
    })
  ),
  window: point,
  hearthGlow: point,
});

export type TavernLayout = z.infer<typeof tavernLayoutSchema>;

export const TAVERN_LAYOUT = layoutJson as TavernLayout;
