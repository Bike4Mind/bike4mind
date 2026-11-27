import type { IncomingHttpHeaders } from 'node:http';
import { SkillListing, type ISkillListingDocument } from '@bike4mind/database';
import { NotFoundError, SKILL_SHARE_TOKEN_HEADER, type ISkillListing } from '@bike4mind/common';
import type { MarketActor } from '@bike4mind/server-utils/skillMarket/market';
import { buildListingDetail } from './detail';

/** The share token from the `x-share-token` header; a missing or repeated header reads as none. */
export function readShareTokenHeader(headers: IncomingHttpHeaders): string | undefined {
  const value = headers[SKILL_SHARE_TOKEN_HEADER];
  return typeof value === 'string' && value ? value : undefined;
}

/** Detail of the unlisted listing a share token opens; 404 for a malformed or unknown token. */
export async function openListingByShareToken(token: string, viewer: MarketActor) {
  // Shape check before the lookup so junk never reaches the query; real tokens are 32 base64url chars.
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) throw new NotFoundError('Listing not found');
  const doc: ISkillListingDocument | null = await SkillListing.findOne({ shareToken: token, deletedAt: null });
  if (!doc) throw new NotFoundError('Listing not found');
  const listing = doc.toJSON() as unknown as ISkillListing;
  return buildListingDetail(listing, viewer, token);
}
