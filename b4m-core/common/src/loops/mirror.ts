import { z } from 'zod';

/**
 * A Desktop-owned loop as the web and phone see it: a read-only, scrubbed status snapshot the Desktop posts
 * (apps/desktop/src/main/loops/local/mirror.ts) and PUT /api/loops/mirror/:localLoopId stores. Strict on both ends:
 * the server refuses any field not listed here, so a goal, description, folder, prompt or transcript never lands.
 */
export const LOOP_MIRROR_TICKETS_MAX = 200;
/** Mirrored loops per user; the server refuses a new one past this. */
export const LOOP_MIRROR_LOOPS_MAX = 50;

const text = (max: number) => z.string().max(max);
const at = z.string().max(40);

export const loopMirrorTicketSchema = z.strictObject({
  title: text(200),
  stage: text(100),
  status: z.enum(['open', 'in_progress', 'blocked', 'closed']),
  priority: z.enum(['p0', 'p1', 'p2', 'p3']).optional(),
  /** Why it is blocked, when it is. */
  reason: text(200).optional(),
});

export const loopMirrorSnapshotSchema = z.strictObject({
  name: text(200),
  status: z.enum(['live', 'paused', 'error']),
  idleReason: text(300).optional(),
  asleepSince: at.optional(),
  cappedUntil: at.optional(),
  stages: z.array(text(100)).max(20),
  lanesBusy: z.number().int().min(0).max(100),
  lanes: z.number().int().min(0).max(100),
  spentToday: z.number().min(0),
  budget: z.number().min(0).optional(),
  needsYou: z.number().int().min(0),
  tickets: z.array(loopMirrorTicketSchema).max(LOOP_MIRROR_TICKETS_MAX),
});

export type LoopMirrorSnapshot = z.infer<typeof loopMirrorSnapshotSchema>;
export type LoopMirrorTicket = z.infer<typeof loopMirrorTicketSchema>;

/** One mirrored loop as GET /api/loops/mirror serves it. */
export interface ILoopMirror {
  localLoopId: string;
  snapshot: LoopMirrorSnapshot;
  lastSeenAt: Date;
}
