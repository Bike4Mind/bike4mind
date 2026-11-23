import {
  CALLABLE_FUNCTION_LAMBDA_EPHEMERAL_STORAGE_MB,
  CALLABLE_FUNCTION_LAMBDA_MEMORY_MB,
  CALLABLE_FUNCTION_LAMBDA_RESERVED_CONCURRENCY,
  CALLABLE_FUNCTION_LAMBDA_TIMEOUT_SECONDS,
  CALLABLE_FUNCTION_PARENT_MARGIN_MS,
} from '../packages/server-utils/src/callableFunctions/runtimeLimits';
import { callableFunctionRolePolicy, subnetNetworkFaults, type RouteTarget } from './callableFunctionNetwork';
import { isPreviewStage, STAGE_LOG_RETENTION_DAYS } from './constants';
import { dlqAlarmTopic } from './dlqAlarms';

// Runs user-written Python (apps/workers/src/callableFunctions/handler.ts, image apps/workers/Dockerfile.callablefunction)
// with no link, secrets, permissions, or environment, in a security group with no rules, on a network of its own with
// no route out and no name resolution. A raw aws.lambda.Function, because sst.aws.Function cannot take a prebuilt
// image; the deploy pipeline builds it per infra/deploy-contract.json and exports CALLABLE_FUNCTION_RUNTIME_IMAGE.
const runtimeImage = process.env.CALLABLE_FUNCTION_RUNTIME_IMAGE;
if (process.env.CI === 'true' && !runtimeImage) {
  console.warn('CALLABLE_FUNCTION_RUNTIME_IMAGE is not set; skipping the callable function runtime.');
}

const namedSubnetIds = (process.env.CALLABLE_FUNCTION_SUBNET_IDS ?? '')
  .split(',')
  .map(id => id.trim())
  .filter(Boolean);

// A network per preview would exhaust the per-region VPC quota, so a preview runs the function only in named subnets.
const skippedOnPreview = isPreviewStage && namedSubnetIds.length === 0;
if (skippedOnPreview) {
  console.warn(
    'CALLABLE_FUNCTION_SUBNET_IDS is not set on this preview stage; skipping the callable function runtime.'
  );
}

const enabled = !$dev && !!runtimeImage && !skippedOnPreview;

const NETWORK_NAME = `${$app.name}-${$app.stage}-callable-function`;

/** A VPC with no gateway, no IPv6, and no name resolution, and one subnet whose table holds only the local route. */
function dedicatedNetwork() {
  const vpc = new aws.ec2.Vpc('CallableFunctionRuntimeVpc', {
    cidrBlock: '10.0.0.0/16',
    enableDnsSupport: false,
    enableDnsHostnames: false,
    assignGeneratedIpv6CidrBlock: false,
    tags: { Name: NETWORK_NAME },
  });
  const subnet = new aws.ec2.Subnet('CallableFunctionRuntimeSubnet', {
    vpcId: vpc.id,
    cidrBlock: '10.0.0.0/20',
    // Lambda documents use1-az3 as limited capacity for VPC functions.
    availabilityZoneId: aws
      .getAvailabilityZonesOutput({ state: 'available', excludeZoneIds: ['use1-az3'] })
      .zoneIds.apply(ids => ids[0]),
    mapPublicIpOnLaunch: false,
    tags: { Name: NETWORK_NAME },
  });
  const routeTable = new aws.ec2.RouteTable('CallableFunctionRuntimeRouteTable', {
    vpcId: vpc.id,
    routes: [],
    tags: { Name: NETWORK_NAME },
  });
  new aws.ec2.RouteTableAssociation('CallableFunctionRuntimeRouteTableAssociation', {
    subnetId: subnet.id,
    routeTableId: routeTable.id,
  });
  return { vpcId: vpc.id, subnetIds: $output([subnet.id]) };
}

/**
 * Every route in the table. The route table data source leaves out the local route, routes propagated from a virtual
 * private gateway, and gateway endpoint routes, so a filtered lookup reads each of those.
 */
function routesOf(routeTableId: string | undefined) {
  if (!routeTableId) return $output([] as RouteTarget[]);
  const has = (name: string, values: string[]) =>
    aws.ec2
      .getRouteTablesOutput({
        filters: [
          { name: 'route-table-id', values: [routeTableId] },
          { name, values },
        ],
      })
      .ids.apply(ids => ids.length > 0);
  return $resolve({
    routes: aws.ec2.getRouteTableOutput({ routeTableId }).routes,
    local: has('route.gateway-id', ['local']),
    endpoint: has('route.gateway-id', ['vpce-*']),
    propagated: has('route.origin', ['EnableVgwRoutePropagation']),
  }).apply(({ routes, local, endpoint, propagated }): RouteTarget[] => [
    ...routes,
    ...(local ? [{ gatewayId: 'local' }] : []),
    ...(endpoint ? [{ gatewayId: 'vpce-*' }] : []),
    ...(propagated ? [{ origin: 'EnableVgwRoutePropagation' }] : []),
  ]);
}

/** The subnets in CALLABLE_FUNCTION_SUBNET_IDS; the deploy fails unless subnetNetworkFaults finds none. */
function namedNetwork(subnetIds: string[]) {
  const subnets = subnetIds.map(subnetId => {
    const vpcId = aws.ec2.getSubnetOutput({ id: subnetId }).vpcId;
    const explicit = aws.ec2.getRouteTablesOutput({
      filters: [{ name: 'association.subnet-id', values: [subnetId] }],
    }).ids;
    const main = aws.ec2.getRouteTablesOutput({ vpcId, filters: [{ name: 'association.main', values: ['true'] }] }).ids;
    const routeTableId = $resolve([explicit, main]).apply(([ids, mainIds]) => ids[0] ?? mainIds[0]);
    return $resolve({
      subnetId,
      vpcId,
      enableDnsSupport: aws.ec2.getVpcOutput({ id: vpcId }).enableDnsSupport,
      routeTableId,
      routes: routeTableId.apply(routesOf),
    });
  });
  const checked = $resolve(subnets).apply(read => {
    const faults = subnetNetworkFaults(read);
    if (faults.length > 0) throw new Error(`CALLABLE_FUNCTION_SUBNET_IDS: ${faults.join('; ')}.`);
    return read;
  });
  return {
    vpcId: checked.apply(read => read[0].vpcId!),
    subnetIds: checked.apply(read => read.map(subnet => subnet.subnetId)),
  };
}

function createCallableFunctionRuntime() {
  const network = namedSubnetIds.length > 0 ? namedNetwork(namedSubnetIds) : dedicatedNetwork();

  const securityGroup = new aws.ec2.SecurityGroup('CallableFunctionRuntimeSecurityGroup', {
    vpcId: network.vpcId,
    description: 'Callable function runtime: no ingress, no egress',
    ingress: [],
    egress: [],
  });

  const role = new aws.iam.Role('CallableFunctionRuntimeRole', {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: 'lambda.amazonaws.com' }),
  });

  const logGroup = new aws.cloudwatch.LogGroup('CallableFunctionRuntimeLogs', {
    retentionInDays: STAGE_LOG_RETENTION_DAYS,
  });

  const rolePolicy = new aws.iam.RolePolicy('CallableFunctionRuntimePolicy', {
    role: role.name,
    policy: logGroup.arn.apply(arn => JSON.stringify(callableFunctionRolePolicy(arn))),
  });

  const fn = new aws.lambda.Function(
    'CallableFunctionRuntime',
    {
      packageType: 'Image',
      imageUri: runtimeImage!,
      // The deploy pipeline builds images for the x86_64 platform the existing image-built services run on.
      architectures: ['x86_64'],
      role: role.arn,
      timeout: CALLABLE_FUNCTION_LAMBDA_TIMEOUT_SECONDS,
      memorySize: CALLABLE_FUNCTION_LAMBDA_MEMORY_MB,
      ephemeralStorage: { size: CALLABLE_FUNCTION_LAMBDA_EPHEMERAL_STORAGE_MB },
      reservedConcurrentExecutions: CALLABLE_FUNCTION_LAMBDA_RESERVED_CONCURRENCY,
      tenancyConfig: { tenantIsolationMode: 'PER_TENANT' },
      vpcConfig: {
        subnetIds: network.subnetIds,
        securityGroupIds: [securityGroup.id],
      },
      loggingConfig: { logFormat: 'Text', logGroup: logGroup.name },
    },
    { dependsOn: [rolePolicy] }
  );

  if (dlqAlarmTopic) createAlarms(fn, dlqAlarmTopic);
  return { fn, subnetIds: network.subnetIds };
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
  // It alarms at 5 in a period, not on a single call's error.
  new aws.cloudwatch.MetricAlarm('CallableFunctionRuntimeErrors', {
    ...common,
    name: `${alarmPrefix}-errors`,
    alarmDescription: 'The callable function runtime Lambda had 5 or more errors in 5 minutes.',
    metricName: 'Errors',
    statistic: 'Sum',
    threshold: 5,
    comparisonOperator: 'GreaterThanOrEqualToThreshold',
    tags: { Application: 'CallableFunctions', Severity: 'Medium' },
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

const runtime = enabled ? createCallableFunctionRuntime() : undefined;

export const callableFunctionRuntime = runtime?.fn;

/** For the stack output: a preview stage in the same account runs the function in these subnets. */
export const callableFunctionSubnetIds = runtime?.subnetIds.apply(ids => ids.join(','));
