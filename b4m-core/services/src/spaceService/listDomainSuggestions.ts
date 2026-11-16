import { ISpaceRepository, IUserDocument, isSpaceMember } from '@bike4mind/common';

export interface SpaceDomainSuggestion {
  spaceId: string;
  spaceName: string;
}

interface ListDomainSuggestionsAdapters {
  db: { spaces: Pick<ISpaceRepository, 'findLiveById'> };
  joinableSpaceIdsForEmail: (email: string) => Promise<string[]>;
}

/** Ids and names of Spaces the caller's verified email could join. Empty for an unverified address. */
export async function listDomainSuggestions(
  user: IUserDocument,
  adapters: ListDomainSuggestionsAdapters
): Promise<SpaceDomainSuggestion[]> {
  if (user.emailVerified !== true || !user.email) return [];
  const suggestions: SpaceDomainSuggestion[] = [];
  for (const spaceId of await adapters.joinableSpaceIdsForEmail(user.email)) {
    const space = await adapters.db.spaces.findLiveById(spaceId);
    if (!space || isSpaceMember(user.id, space) || space.removedUserIds.includes(user.id)) continue;
    suggestions.push({ spaceId: space.id, spaceName: space.name });
  }
  return suggestions;
}
