import {
  CALLABLE_FUNCTION_LAMBDA_EPHEMERAL_STORAGE_MB,
  CALLABLE_FUNCTION_LAMBDA_MEMORY_MB,
  CALLABLE_FUNCTION_LAMBDA_TIMEOUT_SECONDS,
  CALLABLE_FUNCTION_PARENT_MARGIN_MS,
} from '../packages/server-utils/src/callableFunctions/runtimeLimits';
import { STAGE_LOG_RETENTION_DAYS } from './constants';
import { dlqAlarmTopic } from './dlqAlarms';
import { vpc, vpcId } from './vpc';

/**
 * Callable function runtime
 *
 * Runs user-written Python functions (apps/workers/src/callableFunctions/handler.ts, image
 * apps/workers/Dockerfile.callablefunction). The guest is untrusted, so the function holds nothing worth reaching:
 * no link, secrets, permissions, or environment (the image sets the two paths the handler reads), and a security
 * group with no rules in subnets with no route out. Per-tenant isolation keeps each caller and code hash in its own
 * warm environments; the runner sends the tenant id (packages/server-utils/src/callableFunctions/runtimeRunner.ts).
 * A raw aws.lambda.Function, because sst.aws.Function builds its own code and cannot take a prebuilt image.
 *
 * Image: the deploy pipeline builds the Dockerfile and exports the URI as CALLABLE_FUNCTION_RUNTIME_IMAGE, per
 * infra/deploy-contract.json. Without it the function is skipped with a warning, as the render worker is, and the
 * runtime is unavailable.
 */
const runtimeImage = process.env.CALLABLE_FUNCTION_RUNTIME_IMAGE;
if (process.env.CI === 'true' && !runtimeImage) {
  console.warn('CALLABLE_FUNCTION_RUNTIME_IMAGE is not set; skipping the callable function runtime.');
}

// A shared VPC (VPC_ID) is owned outside this stack, so its isolated subnets are too: the deployer names them.
const sharedVpcSubnetIds = (process.env.CALLABLE_FUNCTION_SUBNET_IDS ?? '')
  .split(',')
  .map(id => id.trim())
  .filter(Boolean);
if (process.env.CI === 'true' && runtimeImage && vpcId && sharedVpcSubnetIds.length === 0) {
  console.warn('CALLABLE_FUNCTION_SUBNET_IDS is not set for the shared VPC; skipping the callable function runtime.');
}

const enabled = !$dev && !!runtimeImage && (!!vpc || sharedVpcSubnetIds.length > 0);

// Above the per-AZ /22 blocks sst.aws.Vpc carves from 10.0.0.0/16.
const ISOLATED_SUBNET_CIDR = '10.0.252.0/22';

/**
 * The subnets the function runs in. In the VPC this stack provisions: one subnet whose route table has no route
 * beyond the VPC itself. In a shared VPC: the named subnets, refused at deploy if their route table has any.
 */
function isolatedSubnetIds() {
  if (vpc) {
    const subnet = new aws.ec2.Subnet('CallableFunctionRuntimeSubnet', {
      vpcId: vpc.id,
      cidrBlock: ISOLATED_SUBNET_CIDR,
      availabilityZone: vpc.nodes.privateSubnets.apply(subnets => subnets[0].availabilityZone),
      mapPublicIpOnLaunch: false,
      tags: { Name: `${$app.name}-${$app.stage}-callable-function-isolated` },
    });
    const routeTable = new aws.ec2.RouteTable('CallableFunctionRuntimeRouteTable', {
      vpcId: vpc.id,
      routes: [],
      tags: { Name: `${$app.name}-${$app.stage}-callable-function-isolated` },
    });
    new aws.ec2.RouteTableAssociation('CallableFunctionRuntimeRouteTableAssociation', {
      subnetId: subnet.id,
      routeTableId: routeTable.id,
    });
    return $output([subnet.id]);
  }
  const tables = sharedVpcSubnetIds.map(subnetId => aws.ec2.getRouteTableOutput({ subnetId }));
  return $resolve(tables.map(table => table.routes)).apply(routeSets => {
    routeSets.forEach((routes, i) => {
      const out = routes.filter(route => route.gatewayId !== 'local');
      if (out.length > 0) {
        throw new Error(`CALLABLE_FUNCTION_SUBNET_IDS: subnet ${sharedVpcSubnetIds[i]} has a route out of the VPC.`);
      }
    });
    return sharedVpcSubnetIds;
  });
}

function createCallableFunctionRuntime() {
  const partition = aws.getPartitionOutput().partition;

  const securityGroup = new aws.ec2.SecurityGroup('CallableFunctionRuntimeSecurityGroup', {
    vpcId: vpc ? vpc.id : vpcId!,
    description: 'Callable function runtime: no ingress, no egress',
    ingress: [],
    egress: [],
  });

  const role = new aws.iam.Role('CallableFunctionRuntimeRole', {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: 'lambda.amazonaws.com' }),
  });
  // Network interfaces in the VPC and the function's own log stream; nothing else.
  new aws.iam.RolePolicyAttachment('CallableFunctionRuntimeVpcAccess', {
    role: role.name,
    policyArn: $interpolate`arn:${partition}:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole`,
  });

  const logGroup = new aws.cloudwatch.LogGroup('CallableFunctionRuntimeLogs', {
    retentionInDays: STAGE_LOG_RETENTION_DAYS,
  });

  const fn = new aws.lambda.Function('CallableFunctionRuntime', {
    packageType: 'Image',
    imageUri: runtimeImage!,
    // The deploy pipeline builds images for the x86_64 platform the existing image-built services run on.
    architectures: ['x86_64'],
    role: role.arn,
    timeout: CALLABLE_FUNCTION_LAMBDA_TIMEOUT_SECONDS,
    memorySize: CALLABLE_FUNCTION_LAMBDA_MEMORY_MB,
    ephemeralStorage: { size: CALLABLE_FUNCTION_LAMBDA_EPHEMERAL_STORAGE_MB },
    tenancyConfig: { tenantIsolationMode: 'PER_TENANT' },
    vpcConfig: {
      subnetIds: isolatedSubnetIds(),
      securityGroupIds: [securityGroup.id],
    },
    loggingConfig: { logFormat: 'Text', logGroup: logGroup.name },
  });

  if (dlqAlarmTopic) createAlarms(fn, dlqAlarmTopic);
  return fn;
}

/** Errors, duration, and throttles, in the shape infra/alarms.ts uses for its Lambda alarms. */
function createAlarms(fn: aws.lambda.Function, topic: aws.sns.Topic | sst.aws.SnsTopic) {
  const alarmPrefix = `${$app.name}-${$app.stage}-callable-function-runtime`;
  const common = {
    namespace: 'AWS/Lambda',
    period: 300,
    evaluationPeriods: 1,
    treatMissingData: 'notBreaching',
    dimensions: { FunctionName: fn.name },
    alarmActions: [topic.arn],
  };

  // The handler turns a failed run into a result, so a Lambda error is a timeout, an out-of-memory, or an init failure.
  new aws.cloudwatch.MetricAlarm('CallableFunctionRuntimeErrors', {
    ...common,
    name: `${alarmPrefix}-errors`,
    alarmDescription: 'The callable function runtime Lambda has errors (timeout, out of memory, or init).',
    metricName: 'Errors',
    statistic: 'Sum',
    threshold: 0,
    comparisonOperator: 'GreaterThanThreshold',
    tags: { Application: 'CallableFunctions', Severity: 'High' },
  });

  // The parent settles every run within its margin of the timeout; a run into that margin means it did not.
  new aws.cloudwatch.MetricAlarm('CallableFunctionRuntimeDuration', {
    ...common,
    name: `${alarmPrefix}-duration`,
    alarmDescription: 'A callable function run reached the parent margin before the Lambda timeout.',
    metricName: 'Duration',
    statistic: 'Maximum',
    threshold: CALLABLE_FUNCTION_LAMBDA_TIMEOUT_SECONDS * 1000 - CALLABLE_FUNCTION_PARENT_MARGIN_MS,
    comparisonOperator: 'GreaterThanOrEqualToThreshold',
    tags: { Application: 'CallableFunctions', Severity: 'Medium' },
  });

  new aws.cloudwatch.MetricAlarm('CallableFunctionRuntimeThrottles', {
    ...common,
    name: `${alarmPrefix}-throttles`,
    alarmDescription: 'Callable function runs are being throttled.',
    metricName: 'Throttles',
    statistic: 'Sum',
    threshold: 0,
    comparisonOperator: 'GreaterThanThreshold',
    tags: { Application: 'CallableFunctions', Severity: 'Medium' },
  });
}

export const callableFunctionRuntime = enabled ? createCallableFunctionRuntime() : undefined;
