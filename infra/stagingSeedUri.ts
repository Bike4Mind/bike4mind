const PREVIEW_STAGE_PATTERN = /^pr\d+$/;

/**
 * Staging connection string for the preview DataSyncer. Empty off-preview, which the handler
 * treats as "skip". Keep the pattern in sync with PREVIEW_STAGE_PATTERN in dataSyncerHandler.ts.
 */
export const stagingSeedUri = (stage: string, uri: string | undefined): string =>
  PREVIEW_STAGE_PATTERN.test(stage) ? uri || '' : '';
