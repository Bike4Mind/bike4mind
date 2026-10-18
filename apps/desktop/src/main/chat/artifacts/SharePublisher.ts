import { isAxiosError } from 'axios';
import { z } from 'zod';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import {
  ALLOWED_MIME_EXACT,
  ArtifactTypeSchema,
  PUBLISH_LIMITS,
  SCOPE_URL_PREFIX,
  type ArtifactType,
  ValidationViolationSchema,
  type PublishResult,
  type UploadUrlResponse,
  type ValidationViolation,
} from '@bike4mind/common';
import type {
  ChatArtifactPublish,
  ChatArtifactPublishProgress,
  ChatArtifactPublishRequest,
  ChatArtifactPublishVisibility,
} from '@shared/chat';

const UPLOAD_URL_ENDPOINT = '/api/publish/artifact/upload-url';
const FINALIZE_ENDPOINT = '/api/publish/artifact/finalize';
const PUBLISHED_LIST_ENDPOINT = '/api/publish/artifacts';

/** index.html is the only file a desktop publish uploads, so its MIME is fixed. */
const INDEX_MIME = 'text/html';

/**
 * Publishes a desktop artifact through the server's three-step publish pipeline, making it
 * reachable by other people.
 *
 * A SIBLING of ArtifactPublisher, not an extension of it, because saving and publishing are
 * different acts. Saving writes a private row to `/api/artifacts` and happens on its own as a
 * turn finishes; publishing puts a page at a URL and may only ever happen because a person
 * asked for it. Nothing in this class is reachable from a model's output: there is no tool for
 * it, and the only callers are the IPC handlers the renderer's publish button invokes.
 *
 * Auth is the same device-flow JWT ArtifactPublisher uses - both publish routes are `baseApi()`
 * handlers - and it never leaves this process. Step 2's upload URL is itself the capability
 * (presigned when hosted, a signed proxy token when self-hosted), so the PUT carries no app
 * credential at all.
 */
export class SharePublisher {
  constructor(
    private readonly getApiClient: () => AuthenticatedApiClient | null,
    private readonly getUserId: () => string | undefined,
    private readonly logger: { debug(message: string): void },
    private readonly onProgress: (progress: ChatArtifactPublishProgress) => void
  ) {}

  /**
   * Run all three steps for one artifact. Never throws: every outcome is a state the card can
   * render, and a thrown error would leave the user with no account of where their content is.
   */
  async publish(request: ChatArtifactPublishRequest): Promise<ChatArtifactPublish> {
    const result = await this.run(request);
    this.onProgress({ artifactId: request.artifactId, step: 'done', result });
    return result;
  }

  private async run(request: ChatArtifactPublishRequest): Promise<ChatArtifactPublish> {
    const api = this.getApiClient();
    const userId = this.getUserId();
    if (!api || !userId) {
      return { status: 'failed', reason: 'Sign in to publish.' };
    }

    const content = request.content.trim();
    if (!content) {
      return { status: 'failed', reason: 'This artifact has no content to publish.' };
    }

    // The raw content IS the upload: finalize renders it into the canonical published page via
    // `renderArtifactIndexHtml` (or transpiles it, for react) once `source.artifactType` says
    // so. Checked against the shared limits HERE rather than after a rejection, so an
    // oversized artifact costs no draft and no upload.
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > PUBLISH_LIMITS.maxFileBytes) {
      return {
        status: 'failed',
        reason: `This artifact is ${formatBytes(bytes)}, over the ${formatBytes(PUBLISH_LIMITS.maxFileBytes)} limit for a single file.`,
      };
    }
    if (bytes > PUBLISH_LIMITS.maxBundleBytes) {
      return {
        status: 'failed',
        reason: `This artifact is ${formatBytes(bytes)}, over the ${formatBytes(PUBLISH_LIMITS.maxBundleBytes)} limit for one publication.`,
      };
    }
    if (!ALLOWED_MIME_EXACT.includes(INDEX_MIME)) {
      return { status: 'failed', reason: 'The server does not accept HTML publications.' };
    }

    const axios = api.getAxiosInstance();

    this.onProgress({ artifactId: request.artifactId, step: 'requesting' });
    let draft: UploadUrlResponse;
    try {
      const response = await axios.post<UploadUrlResponse>(UPLOAD_URL_ENDPOINT, {
        tier: 'user',
        scopeId: userId,
        slug: toSlug(request.title, request.artifactId),
        title: request.title.slice(0, 200) || 'Shared artifact',
        visibility: request.visibility,
        source: { kind: 'bundle', artifactId: request.artifactId, artifactType: toArtifactType(request.type) },
        files: [{ path: 'index.html', size: bytes, mimeType: INDEX_MIME }],
      });
      draft = response.data;
    } catch (err) {
      return this.describeRequestFailure(err, request.artifactId);
    }

    const upload = draft.uploadUrls?.find(entry => entry.path === 'index.html');
    if (!upload) {
      return { status: 'failed', reason: 'The server issued no upload address for this artifact.' };
    }

    this.onProgress({ artifactId: request.artifactId, step: 'uploading' });
    try {
      // Plain fetch, no app auth header: the URL carries its own capability either way. A
      // self-hosted server answers step 1 with a same-origin PATH, which a browser would
      // resolve implicitly and this process has to resolve explicitly - that is URL
      // resolution, not a branch on the deployment.
      const target = new URL(upload.url, axios.defaults.baseURL ?? undefined);
      const response = await fetch(target, {
        method: 'PUT',
        headers: { 'Content-Type': INDEX_MIME },
        body: content,
      });
      if (!response.ok) {
        return { status: 'failed', reason: `Uploading the artifact failed (${response.status}).` };
      }
    } catch (err) {
      this.logger.debug(`PUBLISH: ${request.artifactId} upload failed: ${describeError(err)}`);
      return { status: 'failed', reason: 'The artifact could not be uploaded.' };
    }

    this.onProgress({ artifactId: request.artifactId, step: 'finalizing' });
    try {
      const { data } = await axios.post<PublishResult>(FINALIZE_ENDPOINT, { draftId: draft.draftId });
      return {
        status: 'published',
        url: this.toAbsoluteUrl(axios.defaults.baseURL, data.url),
        visibility: toPublishVisibility(data.visibility) ?? request.visibility,
        publishedAt: data.publishedAt,
      };
    } catch (err) {
      return this.describeFinalizeFailure(err, request.artifactId);
    }
  }

  /**
   * Whether this artifact already has a publication of the caller's, read ON DEMAND.
   *
   * Never called for a list: `?sourceArtifactId=` is one query per artifact, so asking for
   * every row of a library would be one request per row. The panel calls this when a row is
   * opened, which is also the only moment the answer is looked at.
   */
  async readState(artifactId: string): Promise<ChatArtifactPublish | null> {
    const api = this.getApiClient();
    if (!api) return { status: 'unknown', reason: 'Sign in to see whether this is shared.' };

    try {
      const axios = api.getAxiosInstance();
      const { data } = await axios.get(PUBLISHED_LIST_ENDPOINT, {
        params: { sourceArtifactId: artifactId, limit: 1 },
      });
      const row = asRecord(data)?.artifacts;
      const first = Array.isArray(row) ? asRecord(row[0]) : undefined;
      if (!first) return null;

      const path = toSharePath(first);
      return {
        status: 'published',
        ...(path ? { url: this.toAbsoluteUrl(axios.defaults.baseURL, path) } : {}),
        ...(toPublishVisibility(first.visibility) ? { visibility: toPublishVisibility(first.visibility) } : {}),
        ...(typeof first.publishedAt === 'string' ? { publishedAt: first.publishedAt } : {}),
      };
    } catch (err) {
      this.logger.debug(`PUBLISH: reading state for ${artifactId} failed: ${describeError(err)}`);
      return { status: 'unknown', reason: describeHttp(err) };
    }
  }

  private toAbsoluteUrl(baseUrl: string | undefined, path: string): string {
    if (!baseUrl) return path;
    try {
      return new URL(path, baseUrl).toString();
    } catch {
      return path;
    }
  }

  /** Step 1 and step 3 both answer a quota refusal, and it is a limit rather than a fault. */
  private describeRequestFailure(err: unknown, artifactId: string): ChatArtifactPublish {
    const quota = toQuotaRejection(err);
    if (quota) return quota;

    this.logger.debug(`PUBLISH: ${artifactId} was not accepted: ${describeError(err)}`);
    if (isAxiosError(err)) {
      const status = err.response?.status;
      if (status === 401) return { status: 'failed', reason: 'Your session has expired. Sign in again.' };
      if (status === 403) return { status: 'failed', reason: 'You are not allowed to publish to this account.' };
      if (status === 400)
        return { status: 'failed', reason: serverMessage(err) ?? 'The server refused this artifact.' };
    }
    return { status: 'failed', reason: describeHttp(err) };
  }

  /**
   * After the bytes are up, a failure is no longer simply "it did not publish". A 422 names
   * what to fix and a quota refusal names a limit, but a request that went out and brought
   * nothing back leaves the outcome genuinely unknown - finalize may have promoted the draft
   * before the connection dropped - so that case says so rather than picking an answer.
   */
  private describeFinalizeFailure(err: unknown, artifactId: string): ChatArtifactPublish {
    this.logger.debug(`PUBLISH: finalizing ${artifactId} failed: ${describeError(err)}`);

    const quota = toQuotaRejection(err);
    if (quota) return quota;

    if (isAxiosError(err)) {
      const status = err.response?.status;
      if (status === 422) {
        return {
          status: 'rejected',
          reason: serverMessage(err) ?? 'This artifact did not pass the publish checks.',
          violations: toViolations(err.response?.data),
        };
      }
      if (status === 401) return { status: 'failed', reason: 'Your session has expired. Sign in again.' };
      if (status === 403) return { status: 'failed', reason: 'You are not allowed to publish to this account.' };
      if (status === 404) return { status: 'failed', reason: 'The upload expired before it could be published.' };
      if (status && status < 500) {
        return { status: 'failed', reason: serverMessage(err) ?? `The server answered ${status}.` };
      }
    }
    return {
      status: 'unknown',
      reason:
        'The server never confirmed this publish, so it may or may not be reachable. Check your published artifacts before sharing the link.',
    };
  }
}

/**
 * A slug the server's SlugSchema will take: lowercase kebab-case, 3-64 characters, never one of
 * the reserved routing tokens. The artifact id's first six characters are appended
 * unconditionally - they are hex from a UUID, so they cannot break the pattern - which both
 * guarantees the minimum length for a title that slugifies to nothing and keeps two artifacts
 * sharing a title from landing on each other's page.
 */
export function toSlug(title: string, artifactId: string): string {
  const stem =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .replace(/-+$/g, '') || 'artifact';
  const suffix =
    artifactId
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 6) || 'shared';
  return `${stem}-${suffix}`;
}

/**
 * The `artifactType` signal that tells finalize to render the raw upload server-side.
 *
 * An unrecognized type becomes 'code', which is what it already is here: `renderArtifactIndexHtml`
 * puts every non-html, non-svg type in a code view, so the page is the same one the type would
 * have produced. Omitting the signal instead would mean "these bytes are the finished page",
 * and raw source would be served as markup.
 */
export function toArtifactType(type: string): ArtifactType {
  const parsed = ArtifactTypeSchema.safeParse(type);
  return parsed.success ? parsed.data : 'code';
}

function toPublishVisibility(value: unknown): ChatArtifactPublishVisibility | undefined {
  return value === 'private' || value === 'organization' || value === 'public' ? value : undefined;
}

function toSharePath(row: Record<string, unknown>): string | undefined {
  const { tier, scopeId, slug } = row;
  if (typeof tier !== 'string' || typeof scopeId !== 'string' || typeof slug !== 'string') return undefined;
  const prefix = SCOPE_URL_PREFIX[tier as keyof typeof SCOPE_URL_PREFIX];
  return prefix ? `${prefix}/${scopeId}/${slug}` : undefined;
}

/**
 * The violations off a 422, parsed with the server's own schema rather than trusted.
 *
 * A body that does not match is dropped instead of being shown: a violation list is advice
 * about what to change, and inventing entries from an unrecognized payload would be worse than
 * the status alone.
 */
function toViolations(data: unknown): ValidationViolation[] | undefined {
  const parsed = z.array(ValidationViolationSchema).safeParse(asRecord(data)?.violations);
  return parsed.success && parsed.data.length ? parsed.data : undefined;
}

/**
 * `checkPublishQuota` answers 4xx with a `code`, and reaching a cap is a normal thing to have
 * happened rather than something that went wrong, so it reads as one.
 */
function toQuotaRejection(err: unknown): ChatArtifactPublish | null {
  if (!isAxiosError(err)) return null;
  const body = asRecord(err.response?.data);
  const code = typeof body?.code === 'string' ? body.code : undefined;
  if (!code?.toLowerCase().includes('quota')) return null;
  return {
    status: 'quota',
    reason: serverMessage(err) ?? 'You have reached your published-artifact limit. Remove a publication to make room.',
  };
}

function serverMessage(err: unknown): string | undefined {
  const body = isAxiosError(err) ? asRecord(err.response?.data) : undefined;
  return typeof body?.error === 'string' ? body.error : undefined;
}

function describeHttp(err: unknown): string {
  if (isAxiosError(err)) {
    const status = err.response?.status;
    if (status === 401) return 'Your session has expired. Sign in again.';
    if (status) return `The server answered ${status}.`;
    return 'The server could not be reached.';
  }
  return describeError(err);
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error.';
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}
