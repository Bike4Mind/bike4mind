/**
 * Lambda keeps an execution environment - the runtime process, anything it started, and /tmp - for
 * later invocations of the same function. The publish-thumbnail renderer must not share one
 * between renders, so this wrapper ends every invocation by delivering the outcome itself through
 * the Runtime API and then exiting the runtime process. Lambda resets the environment and runs
 * the next invocation in a freshly started runtime.
 *
 * The outcome is POSTed before the exit, and Lambda returns an accepted (202) response to the
 * caller without waiting for the runtime to ask for its next event, so the caller sees an ordinary
 * result or function error. The invocation's own REPORT line records the exit as
 * Runtime.ExitError; that is expected. Exiting without posting first would race the runtime
 * client's own post and could turn a successful render into a failed invoke.
 * Runtime API: https://docs.aws.amazon.com/lambda/latest/dg/runtimes-api.html
 */

const RUNTIME_API_VERSION = '2018-06-01';
/** Ceiling on one POST to the local Runtime API (ms). */
const POST_TIMEOUT_MS = 10_000;
/** Time kept back from the handler's deadline for posting its outcome (ms); a local POST takes far less. */
const POST_RESERVE_MS = 1_000;

/** The slice of the Lambda context this needs; declared here because the renderer imports no AWS packages. */
export interface InvocationContext {
  awsRequestId: string;
  /** Time left before Lambda's own timeout kills the runtime (ms). */
  getRemainingTimeInMillis?: () => number;
}

/** What the wrapped handler is told about its invocation. */
export interface Invocation {
  /** Epoch ms by which the handler must settle for its outcome to be posted; undefined when unknown. */
  deadline?: number;
}

export interface ExitAfterEachInvocationOptions {
  /** `host:port` of the Runtime API; read from AWS_LAMBDA_RUNTIME_API at invoke time when absent. */
  runtimeApi?: string;
  fetchImpl?: typeof fetch;
  exit?: (code: number) => void;
}

/** Wraps `handler` so each invocation posts its own outcome to the Runtime API, then exits the runtime. */
export function exitAfterEachInvocation(
  handler: (event: unknown, invocation: Invocation) => Promise<unknown>,
  { runtimeApi, fetchImpl, exit = code => process.exit(code) }: ExitAfterEachInvocationOptions = {}
) {
  return async (event: unknown, context: InvocationContext): Promise<void> => {
    const api = runtimeApi ?? process.env.AWS_LAMBDA_RUNTIME_API;
    // Checked before the handler runs: without both there is no way to deliver its outcome.
    if (!api || !context?.awsRequestId) {
      throw new Error('the publish thumbnail renderer runs only under the Lambda Runtime API');
    }

    const remainingMs = context.getRemainingTimeInMillis?.();
    const deadline = remainingMs === undefined ? undefined : Date.now() + remainingMs - POST_RESERVE_MS;

    let post: { kind: 'response' | 'error'; body: string; headers: Record<string, string> };
    try {
      post = {
        kind: 'response',
        body: JSON.stringify(await handler(event, { deadline })),
        headers: { 'Content-Type': 'application/json' },
      };
    } catch (err) {
      // The runtime client logs a failed invocation; posting the error ourselves must not drop that line.
      console.error('publish thumbnail renderer: the invocation failed', err);
      const errorType = err instanceof Error ? err.name.replace(/[^\w.]/g, '') || 'Error' : 'Error';
      const errorMessage = err instanceof Error ? err.message : String(err);
      post = {
        kind: 'error',
        body: JSON.stringify({ errorType, errorMessage }),
        headers: { 'Content-Type': 'application/json', 'Lambda-Runtime-Function-Error-Type': errorType },
      };
    }

    const url = `http://${api}/${RUNTIME_API_VERSION}/runtime/invocation/${encodeURIComponent(context.awsRequestId)}/${post.kind}`;
    try {
      const response = await (fetchImpl ?? fetch)(url, {
        method: 'POST',
        headers: post.headers,
        body: post.body,
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
      if (response.status !== 202) {
        console.error(
          `publish thumbnail renderer: the Runtime API answered HTTP ${response.status} to the ${post.kind}`
        );
      }
    } catch (err) {
      // The caller then sees the exit as a failed invoke and the orchestrator retries.
      console.error(`publish thumbnail renderer: could not post the ${post.kind} to the Runtime API`, err);
    }
    exit(0);
  };
}
