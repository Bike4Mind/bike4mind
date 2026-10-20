import { createHash } from 'crypto';
import archiver from 'archiver';
import { SkillListing, SkillListingVersion } from '@bike4mind/database';
import {
  claudeMarketplaceNameFor,
  claudePluginNameFor,
  claudeSkillNameFor,
  requireEnv,
  toAbsoluteUrl,
  toSkillMd,
  type ClaudeMarketplace,
  type ISkillListing,
  type ISkillListingVersion,
} from '@bike4mind/common';
import { marketVisibilityFilter } from './market';

/**
 * Claude Code plugin feed for an org's Skill Market listings, served by
 * pages/api/v1/skills/market/claude-marketplace.json.ts and [id]/claude-plugin.zip.ts.
 *
 * The feed pins each zip by sha256, so a zip must be byte-identical on every build: no compression
 * (zlib output can change between Node versions), a fixed entry date, and a SKILL.md that depends
 * on nothing per-request or per-caller.
 */

// Local-time constructor on purpose: zip stores local DOS date fields, so this encodes the same in any TZ.
const ZIP_ENTRY_DATE = new Date(2000, 0, 1);

const appUrl = () => requireEnv('APP_URL', process.env.APP_URL);

const pluginZipUrl = (listingId: string): string =>
  toAbsoluteUrl(appUrl(), `/api/v1/skills/market/${encodeURIComponent(listingId)}/claude-plugin.zip`);

/** Same stamp as the listing page's SKILL.md export (ListingDetail), minus the export date. */
function skillMdFor(listing: ISkillListing, version: ISkillListingVersion): string {
  return toSkillMd(version.snapshot, {
    sourceUrl: toAbsoluteUrl(appUrl(), `/skills/market/${encodeURIComponent(String(listing.id))}`),
    version: version.version,
    thirdParty: true,
  });
}

function buildPluginZip(skillName: string, skillMd: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { store: true });
    const chunks: Buffer[] = [];
    archive.on('data', (chunk: Buffer) => chunks.push(chunk));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);
    archive.append(skillMd, { name: `skills/${skillName}/SKILL.md`, date: ZIP_ENTRY_DATE });
    void archive.finalize();
  });
}

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

/** The listing's plugin zip, or null when it has no approved version to serve. */
export async function pluginZipFor(listing: ISkillListing): Promise<Buffer | null> {
  const version = await approvedVersionOf(listing);
  return version ? zipOf(listing, version) : null;
}

// The one zip builder for both routes, so the feed's sha256 always matches what the zip route serves.
const zipOf = (listing: ISkillListing, version: ISkillListingVersion) =>
  buildPluginZip(skillDirName(version), skillMdFor(listing, version));

/** Only `currentApprovedVersionId` content is served, and only while that version is still approved. */
async function approvedVersionOf(listing: ISkillListing): Promise<ISkillListingVersion | null> {
  if (!listing.currentApprovedVersionId) return null;
  const doc = await SkillListingVersion.findById(listing.currentApprovedVersionId);
  const version = doc?.toJSON() as unknown as ISkillListingVersion | undefined;
  return version && ['approved', 'auto_approved'].includes(version.reviewStatus) ? version : null;
}

// Not the feed's (collision-suffixed) plugin name, so the zip does not depend on the other listings.
const skillDirName = (version: ISkillListingVersion) => claudeSkillNameFor(version.snapshot.name);

/** The marketplace.json for one org: its approved Organization listings, oldest first. */
export async function buildClaudeMarketplace(
  org: { id: string; name?: string },
  memberOrgIds: string[]
): Promise<ClaudeMarketplace> {
  const docs = await SkillListing.find({
    ...marketVisibilityFilter(memberOrgIds),
    visibility: 'organization',
    organizationId: org.id,
  }).sort({ _id: 1 });
  const listings = docs.map(d => d.toJSON() as unknown as ISkillListing);

  // Oldest first, so a later listing with the same name is the one that gets the id suffix.
  const taken = new Set<string>();
  const plugins: ClaudeMarketplace['plugins'] = [];
  // ponytail: builds every zip per fetch; cache the sha on the version doc if an org has hundreds of listings.
  for (const listing of listings) {
    const version = await approvedVersionOf(listing);
    if (!version) continue;
    const zip = await zipOf(listing, version);
    plugins.push({
      name: claudePluginNameFor(version.snapshot.name, String(listing.id), taken),
      description: version.snapshot.description,
      version: String(version.version),
      source: { source: 'archive', url: pluginZipUrl(String(listing.id)), sha256: sha256(zip) },
    });
  }

  return { name: claudeMarketplaceNameFor(org), owner: { name: org.name || 'Bike4Mind' }, plugins };
}
