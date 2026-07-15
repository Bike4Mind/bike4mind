/**
 * Pure helpers for the Lambda-function defaults repeated across product infra:
 * runtime, log retention, environment merge, and stage-gated reserved
 * concurrency. Returns plain argument fragments to spread into
 * `new sst.aws.Function(...)` / `queue.subscribe(...)` args.
 */

export const DEFAULT_FUNCTION_RUNTIME = 'nodejs24.x';
export const DEFAULT_LOG_RETENTION = '3 days';

/** Stages where reserved concurrency is safe to set (see stageGatedConcurrency). */
export const CONCURRENCY_GATED_STAGES = ['production', 'dev'] as const;

export interface FunctionDefaultsOptions {
  /** Lambda runtime. Defaults to nodejs24.x. */
  runtime?: string;
  /** CloudWatch log retention. Defaults to '3 days'. */
  logRetention?: string;
  /** Base environment (e.g. the product's DEFAULT_LAMBDA_ENVIRONMENT). */
  environment?: Record<string, string>;
  /** Per-function environment merged over the base. */
  extraEnvironment?: Record<string, string>;
}

export interface FunctionDefaultArgs {
  runtime: string;
  logging: { retention: string };
  environment: Record<string, string>;
}

/**
 * Builds the arg fragment shared by virtually every Lambda in product infra.
 * Spread it first so per-function args can still override any field:
 *
 *   queue.subscribe({ ...buildFunctionDefaults({ environment: DEFAULT_LAMBDA_ENVIRONMENT }),
 *                     handler: '...', timeout: '5 minutes' });
 */
export function buildFunctionDefaults(options: FunctionDefaultsOptions = {}): FunctionDefaultArgs {
  const {
    runtime = DEFAULT_FUNCTION_RUNTIME,
    logRetention = DEFAULT_LOG_RETENTION,
    environment = {},
    extraEnvironment = {},
  } = options;
  return {
    runtime,
    logging: { retention: logRetention },
    environment: { ...environment, ...extraEnvironment },
  };
}

/**
 * Returns `concurrency` only on gated stages, undefined elsewhere. Reserved
 * concurrency on ephemeral PR stages would exhaust the account-wide unreserved
 * pool, so products only set it on long-lived stages.
 */
export function stageGatedConcurrency<T>(
  stage: string,
  concurrency: T,
  gatedStages: readonly string[] = CONCURRENCY_GATED_STAGES
): T | undefined {
  return gatedStages.includes(stage) ? concurrency : undefined;
}
