import { createHash } from 'crypto';
import archiver from 'archiver';
import { SkillBundle, SkillListing, SkillListingVersion, assignClaudePluginName } from '@bike4mind/database';
import {
  claudeMarketplaceNameFor,
  claudeSkillNameFor,
  requireEnv,
  toAbsoluteUrl,
  type ClaudeMarketplace,
  type ISkillBundle,
  type ISkillFile,
  type ISkillListing,
  type ISkillListingVersion,
} from '@bike4mind/common';
import { toSkillMd } from '@bike4mind/common/utils/skillMd';
import { marketVisibilityFilter } from '@bike4mind/server-utils/skillMarket/market';

/**
 * Claude Code plugin feed for an org's Skill Market listings and bundles, served by
 * pages/api/v1/skills/market/claude-marketplace.json.ts, [id]/claude-plugin.zip.ts and
 * bundles/[id]/claude-plugin.zip.ts.
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

const bundleZipUrl = (baseUrl: string, bundleId: string): string =>
  toAbsoluteUrl(baseUrl, `/api/v1/skills/market/bundles/${encodeURIComponent(bundleId)}/claude-plugin.zip`);

/**
 * Same stamp as the listing page's SKILL.md export (ListingDetail), minus the export date. Stays on
 * APP_URL, not the request origin: it is hashed into the feed's sha256. `name` overrides the
 * frontmatter name, which Claude Code prefers over the directory name.
 */
function skillMdFor(listing: ISkillListing, version: ISkillListingVersion, name = version.snapshot.name): string {
  return toSkillMd(
    { ...version.snapshot, name },
    {
      sourceUrl: toAbsoluteUrl(appUrl(), `/skills/market/${encodeURIComponent(String(listing.id))}`),
      version: version.version,
      thirdParty: true,
    }
  );
}

type ZipSkill = { dir: string; skillMd: string; files?: ISkillFile[] };

// Entries go in the given skill order, files sorted by path (checkSkillFiles / toSnapshot), so the bytes are stable.
function buildPluginZip(skills: ZipSkill[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { store: true });
    const chunks: Buffer[] = [];
    archive.on('data', (chunk: Buffer) => chunks.push(chunk));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);
    for (const { dir, skillMd, files = [] } of skills) {
      archive.append(skillMd, { name: `skills/${dir}/SKILL.md`, date: ZIP_ENTRY_DATE });
      for (const file of files) {
        // Executable in case the extractor keeps unix modes; SKILL.md should still call scripts via an interpreter.
        archive.append(file.content, {
          name: `skills/${dir}/${file.path}`,
          date: ZIP_ENTRY_DATE,
          ...(file.path.startsWith('scripts/') ? { mode: 0o755 } : {}),
        });
      }
    }
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
  buildPluginZip([
    { dir: skillDirName(version), skillMd: skillMdFor(listing, version), files: version.snapshot.files },
  ]);

/**
 * A bundle's plugin zip: each member's current approved version, or null when no member is servable.
 * A member that is delisted, deleted, moved out of the org or unapproved simply drops out. Each skill
 * sits under its listing's `claudePluginName`, unique in the org, so two same-named skills can't collide.
 * Shared by the feed and the bundle zip route so the feed's sha256 matches what the route serves.
 */
export async function bundleZipFor(bundle: ISkillBundle): Promise<Buffer | null> {
  const docs = await SkillListing.find({
    ...marketVisibilityFilter([bundle.organizationId]),
    _id: { $in: bundle.listingIds },
    visibility: 'organization',
    organizationId: bundle.organizationId,
  });
  const listings = docs.map(d => d.toJSON() as unknown as ISkillListing);
  const versionDocs = await SkillListingVersion.find({
    _id: { $in: listings.flatMap(l => (l.currentApprovedVersionId ? [l.currentApprovedVersionId] : [])) },
  });
  const versions = new Map(
    versionDocs.map(d => {
      const version = d.toJSON() as unknown as ISkillListingVersion;
      return [String(version.id), version];
    })
  );
  const skills = listings.flatMap(listing => {
    const version = servable(versions.get(String(listing.currentApprovedVersionId)));
    const dir = listing.claudePluginName;
    return version && dir ? [{ dir, skillMd: skillMdFor(listing, version, dir), files: version.snapshot.files }] : [];
  });
  if (!skills.length) return null;
  return buildPluginZip(skills.sort((a, b) => (a.dir < b.dir ? -1 : 1)));
}

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

  // ponytail: builds every listing and bundle zip per fetch; cache the sha on the version/bundle doc if an org has hundreds of listings.
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

  // After the naming pass above, so a member approved before names were stored is not left out.
  const bundles = (await SkillBundle.find({ organizationId: org.id }).sort({ _id: 1 })).map(
    d => d.toJSON() as unknown as ISkillBundle
  );
  // The listing/bundle name checks are check-then-insert across two collections, so a race can still
  // pair them; the listing keeps the name and the bundle drops out of the feed.
  const listingNames = new Set(plugins.flatMap(p => (p ? [p.name] : [])));
  const bundlePlugins = await Promise.all(
    bundles.map(async bundle => {
      if (listingNames.has(bundle.pluginName)) return null;
      const zip = await bundleZipFor(bundle);
      if (!zip) return null;
      const sha = sha256(zip);
      return {
        name: bundle.pluginName,
        description: bundle.description,
        // Claude Code compares versions for equality only, so the content hash is a valid version that
        // changes exactly when the bytes do (a member approval, a membership edit).
        version: sha.slice(0, 12),
        source: { source: 'archive' as const, url: bundleZipUrl(baseUrl, String(bundle.id)), sha256: sha },
      };
    })
  );

  return {
    name: claudeMarketplaceNameFor(org.id),
    owner: { name: org.name || 'Bike4Mind' },
    forceRemoveDeletedPlugins: true,
    plugins: [...plugins, ...bundlePlugins].filter(p => p !== null),
  };
}
