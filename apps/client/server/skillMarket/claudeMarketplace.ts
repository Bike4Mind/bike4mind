import { createHash } from 'crypto';
import archiver from 'archiver';
import { SkillListing, SkillListingVersion, assignClaudePluginName } from '@bike4mind/database';
import {
  claudeMarketplaceNameFor,
  claudeSkillNameFor,
  requireEnv,
  toAbsoluteUrl,
  type ClaudeMarketplace,
  type ISkillListing,
  type ISkillListingVersion,
} from '@bike4mind/common';
import { toSkillMd } from '@bike4mind/common/utils/skillMd';
import { marketVisibilityFilter } from './market';

/**
 * Claude Code plugin feed for an org's Skill Market listings, served by
 * pages/api/v1/skills/market/claude-marketplace.json.ts and [id]/claude-plugin.zip.ts.
 *
 * The feed pins each zip by sha256, so a zip must be byte-identical on every build: no compression
 * (zlib output can change between Node versions), a fixed entry date, and a SKILL.md that depends
 * on nothing per-request or per-caller.
 */

// Archiver writes UTC DOS date fields by default; fix the instant across runtime timezones.
const ZIP_ENTRY_DATE = new Date(Date.UTC(2000, 0, 1));

const appUrl = () => requireEnv('APP_URL', process.env.APP_URL);

const pluginZipUrl = (baseUrl: string, listingId: string, version: number): string =>
  toAbsoluteUrl(baseUrl, `/api/v1/skills/market/${encodeURIComponent(listingId)}/claude-plugin.zip?version=${version}`);

/**
 * Same stamp as the listing page's SKILL.md export (ListingDetail), minus the export date. Stays on
 * APP_URL, not the request origin: it is hashed into the feed's sha256.
 */
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
export async function pluginZipFor(listing: ISkillListing, versionNumber?: number): Promise<Buffer | null> {
  const version = await approvedVersionOf(listing, versionNumber);
  return version ? zipOf(listing, version) : null;
}

// The one zip builder for both routes, so the feed's sha256 always matches what the zip route serves.
const zipOf = (listing: ISkillListing, version: ISkillListingVersion) =>
  buildPluginZip(skillDirName(version), skillMdFor(listing, version));

/** A pinned version must belong to this listing and remain approved; unpinned requests use the current version. */
async function approvedVersionOf(listing: ISkillListing, versionNumber?: number): Promise<ISkillListingVersion | null> {
  if (!listing.currentApprovedVersionId) return null;
  const doc =
    versionNumber === undefined
      ? await SkillListingVersion.findById(listing.currentApprovedVersionId)
      : await SkillListingVersion.findOne({ listingId: String(listing.id), version: versionNumber });
  return servable(doc?.toJSON() as unknown as ISkillListingVersion | undefined);
}

const servable = (version: ISkillListingVersion | undefined): ISkillListingVersion | null =>
  version && ['approved', 'auto_approved'].includes(version.reviewStatus) ? version : null;

// The bare skill name, not the stored plugin name, so the skill reads as /review-pr inside the plugin
// and the zip depends on no other listing.
const skillDirName = (version: ISkillListingVersion) => claudeSkillNameFor(version.snapshot.name);

/**
 * The marketplace.json for one org: its approved Organization listings, oldest first. `baseUrl` is
 * the origin for the zip URLs: pass publicAppUrl(req) so they match the feed URL the tab shows.
 */
export async function buildClaudeMarketplace(
  org: { id: string; name?: string },
  memberOrgIds: string[],
  baseUrl: string
): Promise<ClaudeMarketplace> {
  const docs = await SkillListing.find({
    ...marketVisibilityFilter(memberOrgIds),
    visibility: 'organization',
    organizationId: org.id,
  }).sort({ _id: 1 });
  const listings = docs.map(d => d.toJSON() as unknown as ISkillListing);

  const versionIds = listings.flatMap(l => (l.currentApprovedVersionId ? [l.currentApprovedVersionId] : []));
  const versionDocs = await SkillListingVersion.find({ _id: { $in: versionIds } });
  const versions = new Map(
    versionDocs.map(d => {
      const version = d.toJSON() as unknown as ISkillListingVersion;
      return [String(version.id), version];
    })
  );

  // Names a listing approved before names were assigned at approval (or whose assignment failed). A
  // write on a GET, but an idempotent CAS that never renames; sequential so the older of two
  // same-named listings keeps the bare slug.
  for (const listing of listings) {
    const version = servable(versions.get(String(listing.currentApprovedVersionId)));
    if (listing.claudePluginName || !version) continue;
    try {
      await assignClaudePluginName(String(listing.id), version.snapshot.name);
      listing.claudePluginName = (await SkillListing.findById(listing.id).select('claudePluginName'))?.claudePluginName;
    } catch (err) {
      // Omit just this listing; one unnamable listing must not take down the whole org feed.
      console.error('[claudeMarketplace] assigning claudePluginName failed', listing.id, err);
    }
  }

  // ponytail: builds every zip per fetch; cache the sha on the version doc if an org has hundreds of listings.
  const plugins = await Promise.all(
    listings.map(async listing => {
      const version = servable(versions.get(String(listing.currentApprovedVersionId)));
      if (!version || !listing.claudePluginName) return null;
      const zip = await zipOf(listing, version);
      return {
        name: listing.claudePluginName,
        description: version.snapshot.description,
        version: String(version.version),
        source: {
          source: 'archive' as const,
          url: pluginZipUrl(baseUrl, String(listing.id), version.version),
          sha256: sha256(zip),
        },
      };
    })
  );

  return {
    name: claudeMarketplaceNameFor(org.id),
    owner: { name: org.name || 'Bike4Mind' },
    forceRemoveDeletedPlugins: true,
    plugins: plugins.filter(p => p !== null),
  };
}
