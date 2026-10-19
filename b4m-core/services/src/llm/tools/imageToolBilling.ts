import type { CostInput } from '../imageCostCalculator/types';

export type ImageToolName = 'image_generation' | 'edit_image';

/** What an image tool call is priced on. Rides both its onStart and onFinish payloads. */
export type ImageToolCostInput = { model?: string; n?: number; size?: string | null; quality?: string | null };

/**
 * The image tools' onFinish payload: the delivered paths plus the cost input, so both credit
 * rails (ToolBuilder.settleImageCredits for classic chat, estimateGeneratedMediaUsd for agent
 * mode) bill on delivery. A call that fails returns before onFinish and is never billed.
 */
export type ImageToolFinishData = ImageToolCostInput & { paths: string[] };

/**
 * The calculator input for one image tool call, shared by both credit rails so they price a
 * call identically. edit_image sends its one source image as input; image_generation sends none.
 */
export function toImageCostInput(toolName: ImageToolName, { model, size, quality }: ImageToolCostInput): CostInput {
  // Runtime tool args are untyped strings; the calculator narrows by model backend.
  return { model, size, quality, inputImageCount: toolName === 'edit_image' ? 1 : 0 } as CostInput;
}
