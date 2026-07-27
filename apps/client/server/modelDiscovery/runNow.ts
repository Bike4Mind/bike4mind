/**
 * Admin "Run now" dispatch (spec sec 7).
 *
 * Both deployments end at the same `runScheduledDiscovery(.., { trigger:
 * 'manual' })`; they differ only in what carries the request there. Hosted has
 * to hand off - the frontend lambda's 60s timeout is far shorter than a run -
 * so it async-invokes the discovery function the cron already targets.
 * Self-host's Next server is a long-lived container, so it starts the run in
 * place.
 *
 * Concurrency is not this module's problem: the service's lease turns a second
 * trigger during an active run into a no-op ('skipped' / 'lease-held'), so the
 * route needs no debounce and a double-click costs nothing.
 */

import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import type { Logger } from '@bike4mind/observability';
import { Resource } from 'sst';

/** How the run was started, for the operator's confirmation line. */
export type DiscoveryDispatchKind = 'lambda' | 'in-process';

/** Nothing is wired to run discovery here: a deployment gap (503), not a bad request. */
export class DiscoveryDispatchUnavailableError extends Error {}

/**
 * The discovery function's name off the `lambdaFunctionNames` Linkable, read
 * through a Record view. The generated sst-env.d.ts only learns the new key on
 * the next deploy, so a compile-time `Resource.lambdaFunctionNames.modelDiscovery`
 * would break a fresh checkout's build - the same bridge as `linkedSecret` in
 * ./adapters.ts. An unlinked name degrades to undefined.
 */
function linkedFunctionName(name: string): string | undefined {
  try {
    return (Resource as unknown as { lambdaFunctionNames?: Record<string, string | undefined> }).lambdaFunctionNames?.[
      name
    ];
  } catch {
    return undefined;
  }
}

export async function dispatchDiscoveryRunNow(logger: Logger): Promise<{ dispatched: DiscoveryDispatchKind }> {
  if (process.env.B4M_SELF_HOST === 'true') {
    // Imported here, not at module scope: this branch is self-host-only and the
    // discovery source registry it pulls in is pure cold-start parse cost for
    // the hosted frontend lambda.
    const { runScheduledDiscovery } = await import('./scheduledRun');
    void runScheduledDiscovery(logger, 'selfhost', { trigger: 'manual' }).catch((error: unknown) => {
      logger.error('[model-discovery] manual run failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return { dispatched: 'in-process' };
  }

  const functionName = linkedFunctionName('modelDiscovery');
  if (!functionName) {
    throw new DiscoveryDispatchUnavailableError('Model discovery function is not linked to this deployment.');
  }

  // 'Event' returns as soon as the invocation is queued; the run reports itself
  // through its run document, which is what the status card polls.
  await new LambdaClient({}).send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify({ trigger: 'manual' })),
    })
  );
  logger.info('[model-discovery] manual run invoked', { functionName });
  return { dispatched: 'lambda' };
}
