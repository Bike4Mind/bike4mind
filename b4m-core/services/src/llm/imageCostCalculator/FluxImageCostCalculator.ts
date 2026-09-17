import { ImageModels } from '@bike4mind/common';
import { CostCalculator } from './types';

export type FluxModel =
  | ImageModels.FLUX_PRO_ULTRA
  | ImageModels.FLUX_PRO_1_1
  | ImageModels.FLUX_PRO
  | ImageModels.FLUX_PRO_FILL
  | ImageModels.FLUX_KONTEXT_PRO
  | ImageModels.FLUX_KONTEXT_MAX;

export interface FluxCostInput {
  model: FluxModel;
}

export class FluxImageCostCalculator implements CostCalculator<FluxCostInput> {
  private readonly modelPrices: Record<FluxModel, number> = {
    [ImageModels.FLUX_PRO_ULTRA]: 0.06,
    [ImageModels.FLUX_PRO_1_1]: 0.04,
    [ImageModels.FLUX_PRO]: 0.05,
    // Fill is the ONLY BFL model EDIT_SUPPORTED_IMAGE_MODELS allows, so both edit
    // dispatchers (ImageEdit.ts and the chat edit_image tool) bill every BFL edit
    // through this entry. Omitting it made them throw "Model not supported".
    [ImageModels.FLUX_PRO_FILL]: 0.05, // $0.05 per inpaint
    [ImageModels.FLUX_KONTEXT_PRO]: 0.035, // $0.035 per transformation
    [ImageModels.FLUX_KONTEXT_MAX]: 0.045, // $0.045 per transformation
  };

  getCost(input: FluxCostInput): number {
    return this.modelPrices[input.model];
  }
}
