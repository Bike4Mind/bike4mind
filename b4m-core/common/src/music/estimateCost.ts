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
 * The request a finished track is billed on. A per-second model bills the provider-reported length, capped at what
 * was requested so the charge never exceeds the hold; without a report it bills the requested length.
 */
export const billedMusicRequest = <T extends Billable>(request: T, reportedDurationSeconds: number | undefined): T =>
  reportedDurationSeconds === undefined || !(reportedDurationSeconds > 0)
    ? request
    : { ...request, durationSeconds: Math.min(reportedDurationSeconds, request.durationSeconds) };
