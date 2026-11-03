import { fabFileRepository } from '@bike4mind/database';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import { getFilesStorage } from '@bike4mind/server-utils/utils/storage/index';

/** How long a reviewer's link to an incident image works; every view signs a fresh one. */
export const INCIDENT_IMAGE_LINK_TTL_SECONDS = 5 * 60;

// Raster only: the link answers with a pinned Content-Type, and vector or document types can run
// script when opened directly.
const DISPLAYABLE_IMAGE_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

export type IncidentImage =
  | { availability: 'ready'; url: string; expiresAt: string }
  | { availability: 'unavailable'; reason: 'no_stored_image' | 'not_displayable' };

/**
 * Signs a short-lived, inline-only read of the object an incident was recorded against. Only
 * upload incidents have one (generated and edited images are blocked before they are stored); the
 * read is signed on the existing files bucket and nothing else is opened up.
 */
export async function signIncidentImage(incident: { fabFileId?: string }, now = new Date()): Promise<IncidentImage> {
  if (!incident.fabFileId || !isValidObjectId(incident.fabFileId)) {
    return { availability: 'unavailable', reason: 'no_stored_image' };
  }
  const file = await fabFileRepository.findById(incident.fabFileId);
  if (!file?.filePath) return { availability: 'unavailable', reason: 'no_stored_image' };
  // The type recorded at scan time is the byte-sniffed one, so it is what the link may claim.
  if (!DISPLAYABLE_IMAGE_TYPES.has(file.mimeType)) return { availability: 'unavailable', reason: 'not_displayable' };

  const url = await getFilesStorage().getSignedUrl(file.filePath, 'get', {
    expiresIn: INCIDENT_IMAGE_LINK_TTL_SECONDS,
    audience: 'browser',
    ResponseContentType: file.mimeType,
    ResponseContentDisposition: 'inline',
  });
  return {
    availability: 'ready',
    url,
    expiresAt: new Date(now.getTime() + INCIDENT_IMAGE_LINK_TTL_SECONDS * 1000).toISOString(),
  };
}
