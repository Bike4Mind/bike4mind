import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import {
  ThumbnailRenderResponseSchema,
  type ThumbnailRenderRequest,
  type ThumbnailRenderResponse,
} from './thumbnailRendererContract';

/**
 * Orchestrator side of the renderer call (see publishThumbnailRenderer.ts for why rendering runs in
 * its own function). The function name arrives through this variable rather than an SST link, so
 * the orchestrator's role gains invoke on exactly that function and nothing else (infra/queues.ts).
 */
export const THUMBNAIL_RENDERER_FUNCTION_ENV = 'PUBLISH_THUMBNAIL_RENDERER_FUNCTION';

/** Client-side ceiling on one synchronous invoke (ms); past the renderer's own Lambda timeout. */
export const THUMBNAIL_RENDERER_INVOKE_TIMEOUT_MS = 90_000;

/** The renderer failed, timed out at the Lambda level, or answered with something unexpected. */
export class ThumbnailRendererError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ThumbnailRendererError';
  }
}

let defaultClient: LambdaClient | undefined;

/**
 * Render one staged document. Throws ThumbnailRendererError for anything that is not a well-formed
 * answer, so the caller lets SQS retry; the payload is never trusted beyond its schema.
 */
export async function invokeThumbnailRenderer(
  request: ThumbnailRenderRequest,
  // One attempt per delivery: a retry re-runs a whole render, and SQS already retries the message.
  client: Pick<LambdaClient, 'send'> = (defaultClient ??= new LambdaClient({ maxAttempts: 1 }))
): Promise<ThumbnailRenderResponse> {
  const functionName = process.env[THUMBNAIL_RENDERER_FUNCTION_ENV];
  if (!functionName) throw new ThumbnailRendererError(`${THUMBNAIL_RENDERER_FUNCTION_ENV} is not set`);

  let result;
  try {
    result = await client.send(
      new InvokeCommand({
        FunctionName: functionName,
        InvocationType: 'RequestResponse',
        Payload: Buffer.from(JSON.stringify(request)),
      }),
      { abortSignal: AbortSignal.timeout(THUMBNAIL_RENDERER_INVOKE_TIMEOUT_MS) }
    );
  } catch (err) {
    throw new ThumbnailRendererError('thumbnail renderer invoke failed', { cause: err });
  }

  const raw = result.Payload ? Buffer.from(result.Payload).toString('utf-8') : '';
  if (result.FunctionError) {
    throw new ThumbnailRendererError(`thumbnail renderer failed (${result.FunctionError}): ${describeError(raw)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ThumbnailRendererError('thumbnail renderer returned a non-JSON payload');
  }
  const response = ThumbnailRenderResponseSchema.safeParse(parsed);
  if (!response.success) throw new ThumbnailRendererError('thumbnail renderer returned an unexpected payload');
  return response.data;
}

/** errorType plus a short one-line message; the text can echo page-influenced strings, so keep it small. */
function describeError(raw: string): string {
  let text = raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      const { errorType, errorMessage } = parsed as Record<string, unknown>;
      text = [errorType, errorMessage].filter(part => typeof part === 'string' && part).join(': ');
    }
  } catch {
    // Not JSON - summarize the raw body.
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, 300) || 'no error detail';
}
