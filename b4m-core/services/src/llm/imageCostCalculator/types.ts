import { FluxCostInput } from './FluxImageCostCalculator';
import { OpenAICostInput } from './OpenAIImageCostCalculator';
import { GeminiImageCostInput } from './GeminiImageCostCalculator';

export type CostInput = OpenAICostInput | FluxCostInput | GeminiImageCostInput;

export interface CostCalculator<T extends CostInput> {
  getCost(input: T): number;
}
