import { z } from 'zod';

/** A type of our own, so a drag of text, a link or files (see useFileDrop) is never taken for a row. */
export const SESSION_DRAG_TYPE = 'application/x-b4m-session';

/** Drag data comes from outside React (any page or app can start a drag), so the id is checked, not trusted. */
const draggedIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^\s]+$/);

export function carriesSession(types: readonly string[]): boolean {
  return types.includes(SESSION_DRAG_TYPE);
}

/** The dragged session id, readable on drop only (browsers hide drag data until then); undefined when invalid. */
export function draggedSessionId(data: Pick<DataTransfer, 'getData' | 'types'>): string | undefined {
  if (!carriesSession(data.types)) return undefined;
  const parsed = draggedIdSchema.safeParse(data.getData(SESSION_DRAG_TYPE));
  return parsed.success ? parsed.data : undefined;
}
