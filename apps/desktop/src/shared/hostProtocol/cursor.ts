import { z } from 'zod';

/**
 * Where a client is in a session's event log. `epoch` identifies one host-process lifetime of the
 * log, `seq` is per session and rises by one per event. A cursor from another epoch cannot be
 * replayed from, so the host answers it with `snapshotRequired`.
 */
export const eventCursorSchema = z.object({
  epoch: z.string().min(1),
  seq: z.number().int().nonnegative(),
});
export type EventCursor = z.infer<typeof eventCursorSchema>;
