import { SkillListingTemplate } from '@bike4mind/database';
import {
  NotFoundError,
  getMcpProviderMetadata,
  skillTemplateFreeRunEligibility,
  skillTemplatePreviewImagePath,
  type ISkillListing,
  type ISkillTemplateExample,
  type ISkillTemplateExampleMediaItem,
} from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import type { MarketActor } from '@bike4mind/server-utils/skillMarket/market';
import { getFilesStorage, getGeneratedImageStorage } from '@bike4mind/server-utils/utils/storage/index';
import { storageReadOverrides } from '@bike4mind/utils/contentDisposition';
import { getBrandName } from '@client/config/general';
import { getOpenSignupStarterCredits } from '@server/utils/starterCredits';
import { sanitizeStoredExampleArtifactHtml } from './templateExample';
import { approvedSnapshotOf, requireOwnListing } from './template';
import { freeRunPageState, renderFreeRunResult } from './templateFreeRun';
import { isPublicTemplatePage, templateImageDeps, templatePageImageFile } from './templateImage';
import { SERVABLE_TEMPLATE_FIELDS, type ServableTemplate, type TemplatePageView } from './templatePage';
import type { TemplatePageExampleView } from './templatePageExample';

/**
 * Assembles what renderTemplatePage draws, for the public page (pages/api/skills/template/serve.ts)
 * and the author's preview (pages/api/skills/market/[id]/template/preview.ts).
 */

// Seconds. The page is served no-store, so a fresh view always gets fresh URLs.
const MEDIA_URL_TTL_SECONDS = 3600;

const CONNECTOR_NAMES: Record<string, string> = {
  github: 'GitHub',
  notion: 'Notion',
  atlassian: 'Jira and Confluence',
};

/** The connectors a skill needs: known MCP providers named by `<server>__<tool>` allowed tools. */
export function requiredConnectors(allowedTools: readonly string[] | undefined): string[] {
  const servers = new Set(
    (allowedTools ?? [])
      .filter(tool => tool.includes('__'))
      .map(tool => tool.split('__')[0].toLowerCase())
      .filter(server => getMcpProviderMetadata(server))
  );
  return [...servers].map(server => CONNECTOR_NAMES[server] ?? server.charAt(0).toUpperCase() + server.slice(1));
}

/** A browser URL for an example media file: images live in the generated-images bucket, videos in files. */
export async function signExampleMedia(item: ISkillTemplateExampleMediaItem): Promise<string> {
  const storage = item.mime.startsWith('video/') ? getFilesStorage() : getGeneratedImageStorage();
  return storage.getSignedUrl(item.key, 'get', {
    expiresIn: MEDIA_URL_TTL_SECONDS,
    audience: 'browser',
    ...storageReadOverrides({ mimeType: item.mime, key: item.key }),
  });
}

/**
 * The example the page plays, or null when there is none to show. `status` only describes the latest
 * run (a failed re-run keeps the earlier content), so the stored reply alone decides.
 */
export async function templatePageExampleOf(
  example: ISkillTemplateExample | null | undefined,
  sign: (item: ISkillTemplateExampleMediaItem) => Promise<string> = signExampleMedia
): Promise<TemplatePageExampleView | null> {
  if (!example?.enabled || !example.reply?.trim()) return null;
  const reply =
    typeof example.replyTrimmedTo === 'number'
      ? example.reply.slice(0, example.replyTrimmedTo).trimEnd()
      : example.reply;
  // Sanitized at harvest too (renderExampleArtifact); re-applied so a stored payload never reaches the page.
  const artifactHtml = example.artifact
    ? sanitizeStoredExampleArtifactHtml(example.artifact.type, example.artifact.html)
    : '';
  const mediaItems = example.media?.items.length ? example.media.items : [];
  const signed = await Promise.all(mediaItems.map(item => sign(item).catch(() => null)));
  const items = mediaItems.flatMap((item, i) => {
    const src = signed[i];
    return src ? [{ src, mime: item.mime, width: item.width, height: item.height }] : [];
  });
  const media =
    example.media && items.length > 0
      ? {
          kind: example.media.kind === 'carousel' && items.length === 1 ? ('image' as const) : example.media.kind,
          items,
        }
      : null;
  return {
    prompt: example.prompt,
    replyHtml: renderFreeRunResult(reply).html,
    steps: (example.steps ?? []).map(step => ({ label: step.label, simulated: Boolean(step.simulated) })),
    artifact: artifactHtml.trim() ? { title: example.artifact?.title ?? '', html: artifactHtml } : null,
    media,
    sampleFile: example.sampleFile
      ? { name: example.sampleFile.name, mime: example.sampleFile.mime, pages: example.sampleFile.pages }
      : null,
  };
}

async function connectorsFor(listing: ISkillListing): Promise<string[]> {
  try {
    return requiredConnectors((await approvedSnapshotOf(listing)).snapshot.allowedTools);
  } catch {
    return [];
  }
}

/** The preview draws the box inert wherever the public page would offer it. */
async function previewFreeRun(
  template: ServableTemplate,
  listing: ISkillListing,
  isPublic: boolean
): Promise<TemplatePageView['freeRun']> {
  if (!template.freeRunEnabled || !isPublic) return null;
  try {
    const { snapshot } = await approvedSnapshotOf(listing);
    return skillTemplateFreeRunEligibility(snapshot).eligible ? { state: 'preview' } : null;
  } catch {
    return null;
  }
}

/**
 * Public pages point at the cacheable public image route; a member-only page or the preview signs the
 * file directly, because that route serves nothing for a listing outside the public audience.
 */
async function imageSrcFor(
  template: ServableTemplate,
  listing: ISkillListing,
  publicRoute: boolean
): Promise<string | null> {
  const file = await templatePageImageFile(template, listing);
  if (!file || !template.previewImage) return null;
  if (publicRoute) return skillTemplatePreviewImagePath(template.slug, template.previewImage.fabFileId);
  return templateImageDeps().signFileUrl(file.filePath, file.mimeType);
}

export async function buildTemplatePageView(args: {
  template: ServableTemplate;
  listing: ISkillListing;
  /** Anyone may open the page (templateImage.ts isPublicTemplatePage). */
  isPublic: boolean;
  origin: string;
  /** The owner preview: inert free-run box, no link-preview tags. */
  preview?: boolean;
  cookieHeader?: string;
  logger?: Logger;
}): Promise<TemplatePageView> {
  const { template, listing, isPublic, origin, preview = false } = args;
  const [imageSrc, starterCredits, freeRun, connectors, example] = await Promise.all([
    imageSrcFor(template, listing, isPublic && !preview),
    isPublic ? getOpenSignupStarterCredits() : Promise.resolve(0),
    preview
      ? previewFreeRun(template, listing, isPublic)
      : freeRunPageState(template, listing, args.cookieHeader).catch(error => {
          args.logger?.warn('template page: free-run state unreadable', error);
          return null;
        }),
    connectorsFor(listing),
    templatePageExampleOf(template.example).catch(error => {
      args.logger?.warn('template page: example unreadable', error);
      return null;
    }),
  ]);
  const brandName = getBrandName();
  return {
    slug: template.slug,
    skillName: listing.name,
    headline: template.headline,
    inputs: template.inputs,
    authorName: listing.authorName ?? null,
    rating: { sum: listing.ratingSum ?? 0, count: listing.ratingCount ?? 0 },
    connectors,
    takesFile: Boolean(template.takesFile),
    example,
    imageSrc,
    starterCredits,
    brandName,
    share:
      isPublic && !preview
        ? {
            canonicalUrl: `${origin}/t/${encodeURIComponent(template.slug)}`,
            imageUrl: imageSrc ? `${origin}${imageSrc}` : null,
            siteName: process.env.APP_NAME || brandName,
          }
        : null,
    freeRun,
  };
}

/** The author's own template, whatever its status, for the preview. */
export async function findOwnPreviewTemplate(
  user: MarketActor,
  listingId: string
): Promise<{ template: ServableTemplate; listing: ISkillListing; isPublic: boolean }> {
  const listing = await requireOwnListing(user, listingId);
  const template = await SkillListingTemplate.findOne({ listingId: String(listing.id) })
    .select(SERVABLE_TEMPLATE_FIELDS)
    .lean<ServableTemplate>();
  if (!template) throw new NotFoundError('Template not found');
  return { template, listing, isPublic: isPublicTemplatePage(listing) };
}
