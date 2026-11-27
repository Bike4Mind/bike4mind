import { exitAfterEachInvocation, type Invocation } from './lambdaRuntimeExit';
import { openLambdaChromiumContext, type OpenWorkspaceContext } from './launchLambdaChromium';
import {
  createRenderEnvironment,
  procfsProcessTable,
  type RenderEnvironment,
  type RenderWorkspace,
} from './renderEnvironment';
import { renderHtmlThumbnail, ThumbnailRenderTimeoutError } from './renderHtmlThumbnail';
import {
  MAX_THUMBNAIL_DOCUMENT_BYTES,
  MAX_THUMBNAIL_IMAGE_BYTES,
  ThumbnailRenderRequestSchema,
  type ThumbnailRenderResponse,
} from './thumbnailRendererContract';

/**
 * Lambda entry point of the publish-thumbnail renderer (infra/queues.ts: PublishThumbnailRenderer),
 * invoked synchronously by the orchestrator (queueHandlers/publishThumbnail.ts).
 *
 * This function runs author-supplied HTML and script, so it is deployed with no links, no secrets,
 * no VPC and a role that can only write its own logs, and this module graph reads no application
 * config: it may import only its siblings here and the browser/image packages
 * (publishThumbnailRenderer.isolation.test.ts). Everything that needs access - loading the
 * artifact, checking its version, storing and recording the image - stays in the orchestrator.
 *
 * No render shares anything with an earlier one: renderEnvironment.ts starts each render with no
 * leftover process or file, in a profile and temp directory of its own, and verifies the teardown
 * (a render it cannot verify fails instead of returning), and lambdaRuntimeExit.ts retires the
 * execution environment after every invocation, so the next render starts in a fresh runtime.
 *
 * Errors throw (the invoke reports a FunctionError and the orchestrator lets SQS retry); a page that
 * wedges the browser past the hard deadline answers `timed-out`, which is permanent for that version.
 */

/** Ceiling on fetching the staged document (ms), before the browser is started. */
const DOCUMENT_FETCH_TIMEOUT_MS = 15_000;

export interface ThumbnailRendererDeps {
  openContext: OpenWorkspaceContext;
  environment: RenderEnvironment;
  loadDocument?: (url: string) => Promise<string>;
}

export function createThumbnailRendererHandler({
  openContext,
  environment,
  loadDocument = fetchThumbnailDocument,
}: ThumbnailRendererDeps) {
  return async (event: unknown, { deadline }: Invocation = {}): Promise<ThumbnailRenderResponse> => {
    const request = ThumbnailRenderRequestSchema.parse(event);
    const render = async (workspace: RenderWorkspace): Promise<ThumbnailRenderResponse> => {
      const srcdoc = await loadDocument(request.documentUrl);

      let image: Buffer;
      try {
        image = await renderHtmlThumbnail({
          srcdoc,
          allowedScriptUrls: request.allowedScriptUrls,
          openContext: options => openContext(options, workspace),
        });
      } catch (err) {
        if (err instanceof ThumbnailRenderTimeoutError) return { status: 'timed-out' };
        throw err;
      }
      if (image.length > MAX_THUMBNAIL_IMAGE_BYTES) {
        throw new Error(`thumbnail image is ${image.length} bytes, over the ${MAX_THUMBNAIL_IMAGE_BYTES}-byte limit`);
      }
      return { status: 'rendered', imageBase64: image.toString('base64') };
    };
    return environment.run(render, { deadline });
  };
}

/** GET the staged document through its presigned link; no redirects, bounded in time and size. */
export async function fetchThumbnailDocument(url: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(DOCUMENT_FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`thumbnail document fetch failed with HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > MAX_THUMBNAIL_DOCUMENT_BYTES) {
    throw new Error(`thumbnail document is ${declared} bytes, over the limit`);
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > MAX_THUMBNAIL_DOCUMENT_BYTES) {
    throw new Error(`thumbnail document is ${body.length} bytes, over the limit`);
  }
  return body.toString('utf-8');
}

/** The only writable path on Lambda, and so the directory emptied around every render. */
export const LAMBDA_SCRATCH_ROOT = '/tmp';

// /tmp is emptied only after the process check finds this runtime alone with its ancestors and
// PID 1 (renderEnvironment.ts). That check, not exitAfterEachInvocation's Runtime API requirement,
// is what protects a shared host: `sst dev` runs this handler locally with AWS_LAMBDA_RUNTIME_API set.
export const handler = exitAfterEachInvocation(
  createThumbnailRendererHandler({
    openContext: openLambdaChromiumContext,
    environment: createRenderEnvironment({ scratchRoot: LAMBDA_SCRATCH_ROOT, processes: procfsProcessTable }),
  })
);
