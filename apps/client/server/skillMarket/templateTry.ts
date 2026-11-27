import { SkillListingImport, skillRepository } from '@bike4mind/database';
import { ConflictError, NotFoundError, type ISkill, type ISkillListing } from '@bike4mind/common';
import { audienceIdsFor, canSeeListing, type MarketActor } from '@bike4mind/server-utils/skillMarket/market';
import { importListing } from './importListing';
import { findServableTemplate, recordTemplateTry, type ServableTemplate } from './templatePage';

/**
 * The "Try with Bike4Mind" step behind `/skills/market/try/$slug`: give the signed-in visitor a copy of
 * the template's skill and return what the client needs to open a prefilled chat.
 */

export type TemplateTryResult = { skillName: string; examplePrompt: string; imported: boolean };

// Each retry asks importListing for a fresh `name-N`, in case a concurrent import took the last one.
const SUFFIX_ATTEMPTS = 3;

const usable = (skill: ISkill | null, userId: string): skill is ISkill =>
  !!skill && skill.userId === userId && !skill.deletedAt;

async function existingCopy(userId: string, listingId: string): Promise<ISkill | null> {
  const row = await SkillListingImport.findOne({ listingId, userId }).select('skillId').lean();
  if (!row?.skillId) return null;
  const skill = await skillRepository.findById(row.skillId);
  return usable(skill, userId) && skill.importedFrom?.listingId === listingId ? skill : null;
}

/** Import under the listing's name, or the first free `name-N` when the visitor already has that name. */
async function importWithSuffix(user: MarketActor, listingId: string, token: string | undefined) {
  let name: string | undefined;
  for (let attempt = 0; attempt <= SUFFIX_ATTEMPTS; attempt += 1) {
    try {
      return (await importListing(user, listingId, { token, ...(name !== undefined ? { name } : {}) })).skill;
    } catch (error) {
      const info = error instanceof ConflictError ? error.additionalInfo : undefined;
      if (info?.code !== 'name_taken' || typeof info.suggestedName !== 'string') throw error;
      name = info.suggestedName;
    }
  }
  throw new ConflictError('Could not find a free name for this skill. Rename one of your skills and try again.');
}

async function ownSourceSkill(user: MarketActor, listing: ISkillListing): Promise<ISkill> {
  const skill = await skillRepository.findById(listing.sourceSkillId);
  if (!usable(skill, user.id)) throw new NotFoundError('The skill this listing was published from no longer exists');
  return skill;
}

type WarnLogger = { warn: (message: string, ...meta: unknown[]) => void };

async function countTry(template: ServableTemplate, logger?: WarnLogger): Promise<void> {
  await recordTemplateTry(template).catch(error => logger?.warn('template try: try count update failed', error));
}

export async function tryTemplate(user: MarketActor, slug: string, logger?: WarnLogger): Promise<TemplateTryResult> {
  const found = await findServableTemplate(slug);
  if (!found) throw new NotFoundError('Template not found');
  const { template, listing } = found;
  const listingId = String(listing.id);
  const examplePrompt = template.examplePrompt ?? '';

  // The author cannot import their own listing; their source skill is the one to open.
  if (listing.authorUserId === user.id) {
    const skillName = (await ownSourceSkill(user, listing)).name;
    await countTry(template, logger);
    return { skillName, examplePrompt, imported: false };
  }

  // A published template page is the listing's share link, so an unlisted listing's token goes with it.
  const token = listing.visibility === 'unlisted' ? listing.shareToken : undefined;
  if (!canSeeListing(listing, await audienceIdsFor(user.id), token)) throw new NotFoundError('Template not found');

  const copy = await existingCopy(user.id, listingId);
  const skillName = copy ? copy.name : (await importWithSuffix(user, listingId, token)).name;
  await countTry(template, logger);
  return { skillName, examplePrompt, imported: !copy };
}
