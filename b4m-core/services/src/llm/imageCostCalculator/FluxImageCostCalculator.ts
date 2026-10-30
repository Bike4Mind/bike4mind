import { ImageModels } from '@bike4mind/common';
import { CostCalculator } from './types';

export type FluxModel =
  | ImageModels.FLUX_PRO_ULTRA
  | ImageModels.FLUX_PRO_1_1
  | ImageModels.FLUX_PRO
  | ImageModels.FLUX_PRO_FILL
  | ImageModels.FLUX_KONTEXT_PRO
  | ImageModels.FLUX_KONTEXT_MAX
  | ImageModels.FLUX_2_MAX
  | ImageModels.FLUX_2_PRO
  | ImageModels.FLUX_2_PRO_PREVIEW
  | ImageModels.FLUX_2_FLEX
  | ImageModels.FLUX_2_KLEIN_9B
  | ImageModels.FLUX_2_KLEIN_9B_PREVIEW
  | ImageModels.FLUX_2_KLEIN_4B;

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
    // FLUX.2 is billed per published megapixel by BFL (https://bfl.ai/pricing); this
    // interface is flat per image, so each entry is the FIRST generated megapixel's
    // rate - which is exactly what a default 1MP request costs. Above 1MP, and
    // reference-image megapixels, are not modelled. The two -preview endpoints have no
    // published rate and are billed at the sibling they pin.
    [ImageModels.FLUX_2_MAX]: 0.07,
    [ImageModels.FLUX_2_PRO]: 0.03,
    [ImageModels.FLUX_2_PRO_PREVIEW]: 0.03,
    [ImageModels.FLUX_2_FLEX]: 0.05, // per generated AND per reference megapixel
    [ImageModels.FLUX_2_KLEIN_9B]: 0.015,
    [ImageModels.FLUX_2_KLEIN_9B_PREVIEW]: 0.015,
    [ImageModels.FLUX_2_KLEIN_4B]: 0.014,
  };

  getCost(input: FluxCostInput): number {
    return this.modelPrices[input.model];
  }
}
