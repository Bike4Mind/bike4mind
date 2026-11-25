import sanitizeHtml from 'sanitize-html';
import { z } from 'zod';
import {
  SkillListingTemplate,
  editSkillTemplateExample,
  fabFileRepository,
  failSkillTemplateExampleRun,
  startSkillTemplateExampleRun,
  type SkillTemplateExampleEdit,
} from '@bike4mind/database';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  SKILL_TEMPLATE_EXAMPLE_ARTIFACT_HTML_MAX,
  SKILL_TEMPLATE_EXAMPLE_ARTIFACT_TITLE_MAX,
  SKILL_TEMPLATE_EXAMPLE_CAROUSEL_MAX_SLIDES,
  SKILL_TEMPLATE_EXAMPLE_DAILY_RUN_CAP,
  SKILL_TEMPLATE_EXAMPLE_IMAGE_MAX_BYTES,
  SKILL_TEMPLATE_EXAMPLE_PROMPT_MAX,
  SKILL_TEMPLATE_EXAMPLE_REPLY_MAX,
  SKILL_TEMPLATE_EXAMPLE_STEP_LABEL_MAX,
  SKILL_TEMPLATE_EXAMPLE_STEPS_MAX,
  SKILL_TEMPLATE_EXAMPLE_VIDEO_MAX_BYTES,
  SKILL_TEMPLATE_EXAMPLE_VIDEO_MAX_SECONDS,
  TooManyRequestsError,
  type ISkillListingTemplate,
  type ISkillTemplateExampleArtifact,
  type ISkillTemplateExampleMedia,
  type ISkillTemplateExampleMediaItem,
  type ISkillTemplateExampleSampleFile,
  type ISkillTemplateExampleStep,
  type SkillTemplateExampleRun,
  type SkillTemplateExampleUpdate,
} from '@bike4mind/common';
import type { MarketActor } from '@bike4mind/server-utils/skillMarket/market';
import type { QuestDispatchIdentity } from '@server/utils/questDispatchSignature';
import {
  plainTemplate,
  requireLiveListing,
  requireOwnListing,
  writeTemplateExample,
  type TemplateScanDeps,
} from './template';
import { requireAudienceMembership } from './author';
import { releaseExampleRun, reserveExampleRun } from './templateExampleCap';
import { FREE_RUN_HTML_OPTIONS, loadFreeRunSettings, renderFreeRunResult } from './templateFreeRun';
import { formatFileCap, freeRunFileMaxBytes, isFreeRunFileType } from './templateFreeRunFile';

/**
 * A template's example run: the platform runs the skill once on the example prompt and the public
 * page replays it. This module is the API side (cap, start, edits, and the pure harvest helpers);
 * the run itself happens on the ChatCompletion service (templateExampleRun.ts), which has no
 * request timeout, reached through `dispatchSigned` at TEMPLATE_EXAMPLE_DISPATCH_PATH.
 */

/** A run still `running` after this long is treated as lost, so the author can start another. */
export const EXAMPLE_RUN_STALE_MS = 15 * 60_000;
/** Session surface that keeps example-run notebooks out of the author's notebook list (SessionModel). */
export const TEMPLATE_EXAMPLE_SESSION_SURFACE = 'skill-template-example';
/** The ChatCompletion internal route (chatCompletion/internal/route.ts). */
export const TEMPLATE_EXAMPLE_DISPATCH_PATH = '/template-example';

export {
  exampleRunCapKey,
  exampleRunsLeftToday,
  releaseExampleRun,
  reserveExampleRun,
  type ExampleRunCap,
} from './templateExampleCap';

/** The signed payload the API sends the ChatCompletion service to run an example. */
export const TemplateExampleDispatchSchema = z.strictObject({
  listingId: z.string().min(1).max(64),
  userId: z.string().min(1).max(64),
  runAt: z.string().datetime(),
  prompt: z.string().min(1).max(SKILL_TEMPLATE_EXAMPLE_PROMPT_MAX),
  versionId: z.string().min(1).max(64),
  takesFile: z.boolean(),
  /** An uploaded sample the author chose; null generates one. */
  sampleFile: z
    .strictObject({ fabFileId: z.string().min(1).max(64), name: z.string().max(255), mime: z.string().max(128) })
    .nullable(),
  cap: z.strictObject({ key: z.string().min(1).max(200), expiresAt: z.string().datetime() }),
});
export type TemplateExampleDispatch = z.infer<typeof TemplateExampleDispatchSchema>;

/** Signature identity for the dispatch; the prefix keeps it apart from any real quest's. */
export const templateExampleDispatchIdentity = (payload: TemplateExampleDispatch): QuestDispatchIdentity => ({
  questId: `template-example:${payload.listingId}`,
  userId: payload.userId,
  sessionId: payload.runAt,
});

export type TemplateExampleStartDeps = {
  dispatch: (payload: TemplateExampleDispatch) => Promise<void>;
  now?: () => number;
};

/**
 * POST /api/skills/market/[id]/template/example: spend one of the author's daily runs and hand the
 * run to the ChatCompletion service. The stored example shows `running` until the service writes it.
 */
export async function startOwnTemplateExample(
  user: MarketActor,
  listingId: string,
  input: SkillTemplateExampleRun,
  deps: TemplateExampleStartDeps
): Promise<ISkillListingTemplate> {
  const listing = await requireOwnListing(user, listingId);
  requireLiveListing(listing);
  await requireAudienceMembership(user.id, listing);
  const id = String(listing.id);
  const doc = await SkillListingTemplate.findOne({ listingId: id });
  if (!doc) throw new NotFoundError('Save the template first');
  if (doc.status === 'in_review') throw new ConflictError('The template is being scanned. Try again in a moment.');
  const prompt = (input.prompt ?? doc.examplePrompt).trim();
  if (!prompt) throw new BadRequestError('Add an example prompt first');

  const now = deps.now?.() ?? Date.now();
  const cap = await reserveExampleRun(user.id, now);
  if (!cap) {
    throw new TooManyRequestsError(
      `You have used all ${SKILL_TEMPLATE_EXAMPLE_DAILY_RUN_CAP} example runs for today. Try again tomorrow (UTC).`
    );
  }
  const runAt = new Date(now);
  const started = await startSkillTemplateExampleRun(id, runAt, new Date(now - EXAMPLE_RUN_STALE_MS)).catch(
    async error => {
      await releaseExampleRun(cap);
      throw error;
    }
  );
  if (!started) {
    await releaseExampleRun(cap);
    throw new ConflictError('An example run is already in progress');
  }

  const sample = started.example?.sampleFile;
  const payload: TemplateExampleDispatch = {
    listingId: id,
    userId: user.id,
    runAt: runAt.toISOString(),
    prompt,
    versionId: String(listing.currentApprovedVersionId),
    takesFile: doc.takesFile === true,
    sampleFile:
      sample?.source === 'upload' && sample.fabFileId
        ? { fabFileId: sample.fabFileId, name: sample.name, mime: sample.mime }
        : null,
    cap,
  };
  try {
    await deps.dispatch(payload);
  } catch (error) {
    await failSkillTemplateExampleRun(id, runAt, 'The example run could not be started');
    await releaseExampleRun(cap);
    throw error;
  }
  return plainTemplate(started);
}

/**
 * PUT /api/skills/market/[id]/template/example: the demo switch, a trim of the stored reply and the
 * sample file. A trim only shortens the reply; a sample file must be the author's own. A change to
 * what a published page shows is re-scanned before it goes live (writeTemplateExample).
 */
export async function editOwnTemplateExample(
  user: MarketActor,
  listingId: string,
  input: SkillTemplateExampleUpdate,
  deps: TemplateScanDeps
): Promise<ISkillListingTemplate> {
  const listing = await requireOwnListing(user, listingId);
  const id = String(listing.id);
  const doc = await SkillListingTemplate.findOne({ listingId: id });
  if (!doc) throw new NotFoundError('Template not found');
  const example = doc.example;
  if (!example) throw new ConflictError('Run the example first');
  if (doc.status === 'in_review') throw new ConflictError('The template is being scanned. Try again in a moment.');

  const edit: SkillTemplateExampleEdit = {};
  if (input.enabled !== undefined) edit.enabled = input.enabled;
  if (input.replyTrimmedTo !== undefined) {
    if (input.replyTrimmedTo !== null && input.replyTrimmedTo >= example.reply.length) {
      throw new BadRequestError('A trim can only shorten the reply');
    }
    edit.replyTrimmedTo = input.replyTrimmedTo;
  }
  if (input.sampleFabFileId !== undefined) {
    edit.sampleFile = input.sampleFabFileId === null ? null : await ownSampleFile(user.id, input.sampleFabFileId);
  }
  if (Object.keys(edit).length === 0) return plainTemplate(doc);

  // Switching the demo off, or editing it while it stays off, shows nothing new. The write re-checks
  // that it is still off (editSkillTemplateExample), so a concurrent switch-on cannot skip the scan.
  const showsNew = edit.enabled ?? example.enabled;
  if (!showsNew) {
    const updated = await editSkillTemplateExample(id, edit);
    if (!updated) throw new ConflictError('The template changed while saving. Reload and try again.');
    return plainTemplate(updated);
  }
  await requireAudienceMembership(user.id, listing);
  if (doc.status === 'published') await deps.beforeScan?.();
  const set: Record<string, unknown> = {};
  if (edit.enabled !== undefined) set['example.enabled'] = edit.enabled;
  if (edit.replyTrimmedTo !== undefined) set['example.replyTrimmedTo'] = edit.replyTrimmedTo;
  if (edit.sampleFile !== undefined) set['example.sampleFile'] = edit.sampleFile;
  const updated = await writeTemplateExample(id, { example: { $exists: true } }, { $set: set }, {}, deps);
  if (!updated) throw new ConflictError('The template changed while saving. Reload and try again.');
  return updated;
}

/**
 * A sample file the author uploaded; used by the next run. It takes the free run's file types and
 * size cap, and must have cleared moderation, which settles a moment after upload.
 */
async function ownSampleFile(userId: string, fabFileId: string): Promise<ISkillTemplateExampleSampleFile> {
  const file = await fabFileRepository.findById(fabFileId);
  if (!file || file.userId !== userId || file.deletedAt || !file.filePath) throw new NotFoundError('File not found');
  const mime = (file.mimeType ?? 'application/octet-stream').split(';')[0].trim().slice(0, 128);
  if (!isFreeRunFileType(mime, file.fileName)) {
    throw new BadRequestError('Choose a PDF, an image (PNG, JPEG, GIF or WebP) or a text file.');
  }
  const maxBytes = freeRunFileMaxBytes((await loadFreeRunSettings()).fileMaxMb);
  if (typeof file.fileSize !== 'number' || file.fileSize > maxBytes) {
    throw new BadRequestError(`Choose a file under ${formatFileCap(maxBytes)}.`);
  }
  if (file.moderationStatus === 'pending' || file.moderationStatus === 'scanning') {
    throw new ConflictError('The file is still being checked. Try again in a moment.');
  }
  if (file.moderationStatus !== 'clean') throw new BadRequestError('This file cannot be used. Choose another one.');
  return { name: file.fileName.slice(0, 255), mime, source: 'upload', fabFileId };
}

// --- Harvest: pure helpers the run uses to turn a finished quest into a stored example ---

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Static, link-free markup an HTML artifact keeps; no scripts, styles, forms, media or URLs. */
const ARTIFACT_HTML_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'p',
    'br',
    'hr',
    'div',
    'span',
    'section',
    'article',
    'header',
    'footer',
    'ul',
    'ol',
    'li',
    'strong',
    'em',
    'b',
    'i',
    'u',
    'del',
    'code',
    'pre',
    'blockquote',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
    'dl',
    'dt',
    'dd',
  ],
  allowedAttributes: { ol: ['start'], th: ['align', 'colspan', 'rowspan'], td: ['align', 'colspan', 'rowspan'] },
  allowedSchemes: [],
  disallowedTagsMode: 'discard',
};

/** Re-applies the allowlist renderExampleArtifact stored `html` under, for the render-time pass. */
export function sanitizeStoredExampleArtifactHtml(type: string, html: string): string {
  return sanitizeHtml(html, type === 'html' ? ARTIFACT_HTML_OPTIONS : FREE_RUN_HTML_OPTIONS);
}

const PROSE_LANGUAGES = new Set(['text', 'markdown', 'md']);

/**
 * A read-only render of one artifact, or null for a type the page cannot show safely (React, SVG,
 * Python and the like make the example chat-only).
 */
export function renderExampleArtifact(artifact: {
  type: string;
  title?: string;
  content: string;
  language?: string;
}): ISkillTemplateExampleArtifact | null {
  let html: string;
  switch (artifact.type) {
    case 'markdown':
    case 'text':
      html = renderFreeRunResult(artifact.content).html;
      break;
    case 'html':
      html = sanitizeHtml(artifact.content, ARTIFACT_HTML_OPTIONS);
      break;
    case 'mermaid':
      html = `<pre><code class="language-mermaid">${escapeHtml(artifact.content)}</code></pre>`;
      break;
    case 'code':
      // The parser files a Markdown artifact as `code` in `text`.
      html = PROSE_LANGUAGES.has((artifact.language ?? 'text').toLowerCase())
        ? renderFreeRunResult(artifact.content).html
        : `<pre><code>${escapeHtml(artifact.content)}</code></pre>`;
      break;
    default:
      return null;
  }
  if (!html.trim() || html.length > SKILL_TEMPLATE_EXAMPLE_ARTIFACT_HTML_MAX) return null;
  const title = (artifact.title ?? '').replace(/\s+/g, ' ').trim().slice(0, SKILL_TEMPLATE_EXAMPLE_ARTIFACT_TITLE_MAX);
  return { type: artifact.type, title, html };
}

/** The reply without its artifact blocks, capped, plus the first artifact the page can show. */
export function harvestExampleReply(
  reply: string,
  parse: (content: string) => {
    artifacts: { type: string; title?: string; content: string; language?: string; startIndex?: number }[];
    cleanedContent: string;
  }
): { reply: string; artifact: ISkillTemplateExampleArtifact | null } {
  const { artifacts, cleanedContent } = parse(reply);
  // parseArtifacts returns them last-first.
  const inOrder = [...artifacts].sort((a, b) => (a.startIndex ?? 0) - (b.startIndex ?? 0));
  let artifact: ISkillTemplateExampleArtifact | null = null;
  for (const candidate of inOrder) {
    artifact = renderExampleArtifact(candidate);
    if (artifact) break;
  }
  return { reply: cleanedContent.trim().slice(0, SKILL_TEMPLATE_EXAMPLE_REPLY_MAX), artifact };
}

export function capExampleSteps(steps: readonly ISkillTemplateExampleStep[]): ISkillTemplateExampleStep[] {
  return steps.slice(0, SKILL_TEMPLATE_EXAMPLE_STEPS_MAX).map(step => ({
    label: step.label.slice(0, SKILL_TEMPLATE_EXAMPLE_STEP_LABEL_MAX),
    simulated: step.simulated,
  }));
}

const isVideo = (item: ISkillTemplateExampleMediaItem) => item.mime.startsWith('video/');
// SVG can carry script, so it is never served as example media.
const isImage = (item: ISkillTemplateExampleMediaItem) =>
  item.mime.startsWith('image/') && !item.mime.startsWith('image/svg');

/**
 * The media the page plays, within the caps. Nothing is re-encoded: an item over a cap is dropped,
 * and a video of unknown length is too. A video wins over images; several images make a carousel.
 */
export function selectExampleMedia(
  items: readonly ISkillTemplateExampleMediaItem[]
): ISkillTemplateExampleMedia | null {
  const video = items.find(
    item =>
      isVideo(item) &&
      item.bytes <= SKILL_TEMPLATE_EXAMPLE_VIDEO_MAX_BYTES &&
      item.durationS !== undefined &&
      item.durationS <= SKILL_TEMPLATE_EXAMPLE_VIDEO_MAX_SECONDS
  );
  if (video) return { kind: 'video', items: [video] };
  const images = items
    .filter(item => isImage(item) && item.bytes <= SKILL_TEMPLATE_EXAMPLE_IMAGE_MAX_BYTES)
    .slice(0, SKILL_TEMPLATE_EXAMPLE_CAROUSEL_MAX_SLIDES);
  if (images.length === 0) return null;
  return { kind: images.length === 1 ? 'image' : 'carousel', items: images };
}
