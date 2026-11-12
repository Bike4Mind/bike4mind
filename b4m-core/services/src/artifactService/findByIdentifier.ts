import { IArtifactRepository } from '@bike4mind/common';
import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { canUserReadArtifact } from './get';
import { identifierFilter } from './identifierFilter';

const findByIdentifierSchema = z.object({
  sessionId: z.string().min(1),
  type: z.string().min(1),
  identifier: z.string().min(1),
});

type FindByIdentifierParameters = z.infer<typeof findByIdentifierSchema>;

interface FindByIdentifierAdapters {
  db: {
    artifacts: IArtifactRepository;
  };
}

/**
 * The newest row in a session for `type` + `identifier` that `userId` may read, or null.
 *
 * Unlike `list`, which is owner-only, this applies the read rule `get` enforces (owner, explicit
 * grant, public), so a user an artifact is shared with resolves the same row the owner does. The
 * caller's own row wins over a newer one belonging to someone else.
 */
export const findByIdentifier = async (
  userId: string,
  parameters: FindByIdentifierParameters,
  adapters: FindByIdentifierAdapters
): Promise<{ id: string } | null> => {
  const { db } = adapters;
  const { sessionId, type, identifier } = secureParameters(parameters, findByIdentifierSchema);

  // Only what canUserReadArtifact, the owner preference and the sort read.
  const rows = await db.artifacts.find(
    {
      sessionId,
      type,
      ...identifierFilter(identifier),
      deletedAt: null,
    },
    { id: 1, userId: 1, visibility: 1, permissions: 1, createdAt: 1 }
  );

  const readable = rows
    .filter(row => canUserReadArtifact(userId, row))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const match = readable.find(row => row.userId === userId) ?? readable[0];
  return match ? { id: match.id } : null;
};
