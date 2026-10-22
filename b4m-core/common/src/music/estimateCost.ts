import { usdToCredits } from '../pricing';
import type { ValidatedMusicRequest } from './request';
import type { MusicModelCapabilities } from './types';

type Billable = Pick<ValidatedMusicRequest, 'durationSeconds'>;

export const estimateMusicCostUsd = (caps: MusicModelCapabilities, request: Billable): number =>
  caps.pricing.unit === 'per_song' ? caps.pricing.usd : caps.pricing.usd * request.durationSeconds;

// Shared by the studio (display) and the server (credit hold) so the two can never drift.
export const estimateMusicCostCredits = (caps: MusicModelCapabilities, request: Billable): number =>
  usdToCredits(estimateMusicCostUsd(caps, request));

/**
 * Seconds a finished track is billed on (may be fractional): the provider-reported length, capped at the requested
 * one so the charge never exceeds the hold. Without a usable report it is the requested length.
 */
export const billedMusicSeconds = (request: Billable, reportedDurationSeconds: number | undefined): number =>
  reportedDurationSeconds !== undefined && reportedDurationSeconds > 0
    ? Math.min(reportedDurationSeconds, request.durationSeconds)
    : request.durationSeconds;
