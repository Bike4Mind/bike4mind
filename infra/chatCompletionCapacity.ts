/**
 * Fargate capacity for the ChatCompletion and subscriberFanoutV2 services.
 *
 * Previews are single-tenant, always-on, and tolerate interruption, and AWS bills Spot well
 * below on-demand, so they run on Spot. `undefined` off-preview is deliberate: SST's
 * `normalizeCapacity()` early-returns on a falsy value, leaving the default
 * `launchType: "FARGATE"`, so production, dev, and personal stages deploy unchanged.
 */
export const chatCompletionCapacity = (isPreview: boolean): 'spot' | undefined => (isPreview ? 'spot' : undefined);

export interface ServiceScaling {
  min: number;
  max: number;
  cpuUtilization?: number;
}

/** Task-count bounds for the ChatCompletion service; the preview wake schedule restores the non-prod value. */
export const chatCompletionScaling = (isProd: boolean): ServiceScaling =>
  isProd ? { min: 2, max: 6, cpuUtilization: 70 } : { min: 1, max: 2 };
