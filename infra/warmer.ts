import { DurationMinutes } from '../.sst/platform/src/components/duration';
import { Input } from '../.sst/platform/src/components/input';
import { lambdaVpc } from './vpc';

export interface WarmerOptions {
  /**
   * Cron schedule for warming invocations
   * @default 'rate(4 minutes)' - every 4 minutes
   */
  schedule?: Input<`rate(${string})` | `cron(${string})`>;

  /**
   * Number of concurrent invocations to keep warm
   * @default 1
   */
  concurrency?: Input<number>;

  /**
   * Whether to enable the warmer
   * @default true for production, false for dev stages
   */
  enabled?: Input<boolean>;

  /**
   * Custom warmer function timeout
   * @default '30 seconds'
   */
  timeout?: Input<DurationMinutes>;
}

/**
 * Creates a warmer that directly invokes a handler function via its handler path
 */
export function createHandlerWarmer(
  name: string,
  functionInstance: { arn: $util.Output<string> },
  options: WarmerOptions = {}
): sst.aws.Cron {
  const {
    schedule = 'rate(4 minutes)',
    concurrency = 1,
    enabled = $app.stage === 'production',
    timeout = '30 seconds',
  } = options;

  return new sst.aws.Cron(`${name}Warmer`, {
    schedule,
    enabled,
    function: {
      vpc: lambdaVpc,
      handler: 'apps/client/server/cron/warmer.dispatch',
      runtime: 'nodejs24.x',
      timeout,
      environment: {
        TARGET_FUNCTION_NAME: functionInstance.arn,
        WARMER_CONCURRENCY: concurrency.toString(),
        WARMER_NAME: name,
      },
      permissions: [
        {
          actions: ['lambda:InvokeFunction'],
          resources: ['*'], // Broad permissions for handler-based invocation
        },
      ],
    },
  });
}
