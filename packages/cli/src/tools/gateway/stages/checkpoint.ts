import path from 'path';
import type { CheckpointStore } from '../../../storage/CheckpointStore.js';
import type { ToolDescriptor } from '../toolDescriptor.js';
import { writePathOf } from '../toolPolicy.js';
import type { ToolArgs } from '../gatewayTypes.js';

/**
 * Snapshot the target of a file write in the shadow git repo so /undo can restore it. Only a
 * tool whose descriptor declares `writePathArg` is checkpointed, on the path the model sent.
 * Called once the permission gate approves the write, so a write denied there or blocked by plan
 * mode leaves no checkpoint (a later fuzzy-edit re-prompt or directory grant can still be denied
 * after it). A checkpoint failure never blocks the write.
 */
export async function checkpointBeforeWrite(
  checkpointStore: CheckpointStore | null | undefined,
  toolName: string,
  descriptor: ToolDescriptor | undefined,
  rawArgs: ToolArgs | undefined
): Promise<void> {
  const writePath = writePathOf(descriptor, rawArgs);
  if (!checkpointStore || !writePath) return;
  try {
    await checkpointStore.createCheckpoint(toolName, [writePath], `before-${toolName}-${path.basename(writePath)}`);
  } catch {
    // Best effort: losing an undo point must not fail the user's write.
  }
}
