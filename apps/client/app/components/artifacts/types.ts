import { type BaseArtifact } from '@bike4mind/common';

/**
 * An artifact as the client handles it. `content` is optional because the list feed omits it - the
 * body lives in a separate content collection that only the :id GET joins - so a value straight
 * from the gallery is unhydrated until a caller fills it in.
 *
 * Shared by the gallery, the editor and their host: these previously carried three separate
 * declarations that had already drifted apart.
 */
export interface ArtifactWithContent extends BaseArtifact {
  content?: string;
  contentSize: number;
  contentHash: string;
  metadata?: Record<string, unknown>;
}
