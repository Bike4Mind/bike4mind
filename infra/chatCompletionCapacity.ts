/**
 * Fargate capacity for the ChatCompletion service.
 *
 * Previews are single-tenant, always-on, and tolerate interruption, and AWS bills Spot well
 * below on-demand, so they run on Spot. `undefined` off-preview is deliberate: SST's
 * `normalizeCapacity()` early-returns on a falsy value, leaving the default
 * `launchType: "FARGATE"`, so production, dev, and personal stages deploy unchanged.
 */
export const chatCompletionCapacity = (isPreview: boolean): 'spot' | undefined => (isPreview ? 'spot' : undefined);
