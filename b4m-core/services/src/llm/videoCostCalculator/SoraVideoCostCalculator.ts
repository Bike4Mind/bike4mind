import { VideoModels, SoraDuration } from '@bike4mind/common';

/**
 * Input for calculating Sora video generation cost
 */
export interface SoraCostInput {
  /** The Sora model used */
  model: VideoModels.SORA_2 | VideoModels.SORA_2_PRO;

  /** Video duration in seconds */
  seconds: SoraDuration;

  /** Video resolution (optional - currently same price for all resolutions) */
  size?: string;
}

/**
 * Cost calculator for OpenAI Sora video generation
 *
 * Note: Pricing is placeholder until OpenAI announces official Sora pricing.
 * Current estimates based on industry patterns and model capabilities.
 */
export class SoraVideoCostCalculator {
  /**
   * Base prices per video generation by model
   * These are placeholder values - update when OpenAI announces pricing
   */
  private readonly basePrices: Record<VideoModels.SORA_2 | VideoModels.SORA_2_PRO, number> = {
    [VideoModels.SORA_2]: 0.25, // $0.25 base for standard model
    [VideoModels.SORA_2_PRO]: 0.5, // $0.50 base for pro model (higher quality)
  };

  /**
   * Duration multiplier (cost scales with duration)
   * Base price is for 4 seconds, multiply for longer durations
   */
  private readonly durationMultipliers: Record<SoraDuration, number> = {
    4: 1.0, // Base duration
    8: 2.0, // 2x for 8 seconds
    12: 3.0, // 3x for 12 seconds
  };

  /**
   * Calculate the cost for a Sora video generation request
   *
   * @param input - The cost calculation input
   * @returns Cost in USD
   */
  getCost(input: SoraCostInput): number {
    const basePrice = this.basePrices[input.model];
    const durationMultiplier = this.durationMultipliers[input.seconds] || 1;

    return basePrice * durationMultiplier;
  }

  /**
   * Get a cost estimate string for display purposes
   *
   * @param input - The cost calculation input
   * @returns Formatted cost string (e.g., "$0.50")
   */
  getCostDisplay(input: SoraCostInput): string {
    const cost = this.getCost(input);
    return `$${cost.toFixed(2)}`;
  }
}
