import { type BaseArtifact } from '@bike4mind/common';

/**
 * An artifact as the client handles it. `content` is optional because the list feed omits it - the
 * body lives in a separate collection that only the :id GET joins - so an artifact straight from
 * the gallery is unhydrated until a caller fills it in.
 */
export type ArtifactWithContent = BaseArtifact & { content?: string };

/** The create/update routes answer with the artifact wrapped in an envelope, never bare. */
export type ArtifactMutationResponse = { artifact: BaseArtifact };
