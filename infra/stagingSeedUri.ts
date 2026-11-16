/**
 * Staging seed URI for the DataSyncer function.
 *
 * Only preview stages seed from staging, so every other stage gets an empty value. The
 * handler treats an empty value as "not configured" and skips the sync.
 */
export const stagingSeedUri = (isPreview: boolean, uri: string | undefined): string => (isPreview ? uri || '' : '');
