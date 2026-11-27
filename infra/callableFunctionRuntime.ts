import {
  CALLABLE_FUNCTION_LAMBDA_EPHEMERAL_STORAGE_MB,
  CALLABLE_FUNCTION_LAMBDA_MEMORY_MB,
  CALLABLE_FUNCTION_LAMBDA_RESERVED_CONCURRENCY,
  CALLABLE_FUNCTION_LAMBDA_TIMEOUT_SECONDS,
  CALLABLE_FUNCTION_PARENT_MARGIN_MS,
} from '../packages/server-utils/src/callableFunctions/runtimeLimits';
import { callableFunctionDataBucket } from './callableFunctionData';
import {
  callableFunctionDataEndpointPolicy,
  callableFunctionRolePolicy,
  DEDICATED_SUBNET_CIDRS,
  distinctZones,
  namedSubnetIdsOf,
  otherPrefixListFilters,
  probeMatched,
  routeProbeFilters,
  subnetNetworkFaults,
  tableRoutes,
  type DataEndpoint,
  type FixedProbe,
  type RouteTarget,
} from './callableFunctionNetwork';
import { PRODUCTION_STAGES, STAGE_LOG_RETENTION_DAYS } from './constants';

// Runs user-written Python (apps/workers/src/callableFunctions/handler.ts) with no link, secrets, or environment, on a
// network with no name resolution and no route out but the function-data endpoint. A raw aws.lambda.Function:
// sst.aws.Function takes no prebuilt image.
const runtimeImage = process.env.CALLABLE_FUNCTION_RUNTIME_IMAGE;
if (process.env.CI === 'true' && !runtimeImage) {
  console.warn('CALLABLE_FUNCTION_RUNTIME_IMAGE is not set; skipping the callable function runtime.');
}

const namedSubnetIds = namedSubnetIdsOf(process.env.CALLABLE_FUNCTION_SUBNET_IDS);

const longLivedStage = PRODUCTION_STAGES.includes($app.stage);

// A network per stage would exhaust the per-region VPC quota, so only production and dev create one; any other stage
// runs the function only in named subnets.
const skippedWithoutNetwork = !longLivedStage && namedSubnetIds.length === 0;
if (skippedWithoutNetwork) {
  console.warn(
    'CALLABLE_FUNCTION_SUBNET_IDS is not set and only production and dev create a network; skipping the callable function runtime on this stage.'
  );
}

const enabled = !$dev && !!runtimeImage && !skippedWithoutNetwork;

// The S3 gateway endpoint of the stage that owns the named subnets: its route is the one the route check accepts.
// The endpoint cannot be read from a table: the route table data source omits a gateway endpoint's route.
const namedDataEndpointId = process.env.CALLABLE_FUNCTION_DATA_ENDPOINT_ID?.trim() || undefined;

const NETWORK_NAME = `${$app.name}-${$app.stage}-callable-function`;

const S3_SERVICE_NAME = $interpolate`com.amazonaws.${aws.getRegionOutput().region}.s3`;

/**
 * A VPC with no gateway, IPv6, or DNS; two subnets in two zones share one table holding the local route and the
 * function-data endpoint's route, whose policy allows GetObject on that bucket's `data/` objects only.
 */
function dedicatedNetwork(dataBucket: aws.s3.Bucket) {
  const vpc = new aws.ec2.Vpc('CallableFunctionRuntimeVpc', {
    cidrBlock: '10.0.0.0/16',
    enableDnsSupport: false,
    enableDnsHostnames: false,
    assignGeneratedIpv6CidrBlock: false,
    tags: { Name: NETWORK_NAME },
  });
  // Lambda documents use1-az3 as limited capacity for VPC functions.
  const zoneIds = aws
    .getAvailabilityZonesOutput({ state: 'available', excludeZoneIds: ['use1-az3'] })
    .zoneIds.apply(ids => distinctZones(ids, DEDICATED_SUBNET_CIDRS.length));
  const subnets = DEDICATED_SUBNET_CIDRS.map(
    (cidrBlock, index) =>
      new aws.ec2.Subnet(`CallableFunctionRuntimeSubnet${index + 1}`, {
        vpcId: vpc.id,
        cidrBlock,
        availabilityZoneId: zoneIds.apply(ids => ids[index]),
        mapPublicIpOnLaunch: false,
        tags: { Name: NETWORK_NAME },
      })
  );
  const routeTable = new aws.ec2.RouteTable('CallableFunctionRuntimeRouteTable', {
    vpcId: vpc.id,
    routes: [],
    tags: { Name: NETWORK_NAME },
  });
  subnets.forEach(
    (subnet, index) =>
      new aws.ec2.RouteTableAssociation(`CallableFunctionRuntimeRouteTableAssociation${index + 1}`, {
        subnetId: subnet.id,
        routeTableId: routeTable.id,
      })
  );
  const dataEndpoint = new aws.ec2.VpcEndpoint('CallableFunctionRuntimeDataEndpoint', {
    vpcId: vpc.id,
    serviceName: S3_SERVICE_NAME,
    vpcEndpointType: 'Gateway',
    routeTableIds: [routeTable.id],
    policy: dataBucket.arn.apply(arn => JSON.stringify(callableFunctionDataEndpointPolicy(arn))),
    tags: { Name: NETWORK_NAME },
  });
  return { vpcId: vpc.id, subnetIds: $output(subnets.map(subnet => subnet.id)), dataEndpoint };
}

/** The endpoint in CALLABLE_FUNCTION_DATA_ENDPOINT_ID, as subnetNetworkFaults reads it. */
function dataEndpointOf(id: string) {
  const endpoint = aws.ec2.getVpcEndpointOutput({ id });
  return $resolve({
    id,
    vpcId: endpoint.vpcId,
    vpcEndpointType: endpoint.vpcEndpointType,
    serviceName: endpoint.serviceName,
    state: endpoint.state,
    prefixListId: endpoint.prefixListId,
    routeTableIds: endpoint.routeTableIds,
    policy: endpoint.policy,
  });
}

// The route table data source omits local and VpcLattice routes, propagated routes, vpce- routes with a prefix list,
// and routes to a network interface attached to another account's instance; a filtered lookup reads each.
function routesOf(
  routeTableId: string | undefined,
  dataEndpoint: $util.Output<DataEndpoint | undefined>,
  prefixListIds: $util.Output<string[]>
) {
  if (!routeTableId) return $output([] as RouteTarget[]);
  const lookup = (filters: Array<{ name: string; values: string[] }>) =>
    aws.ec2.getRouteTablesOutput({ filters }).ids.apply(probeMatched);
  const probe = (kind: FixedProbe) => lookup(routeProbeFilters(routeTableId, kind));
  const otherPrefixList = $util.all([prefixListIds, dataEndpoint]).apply(([ids, endpoint]) => {
    const filters = otherPrefixListFilters(routeTableId, ids, endpoint?.prefixListId);
    return filters ? lookup(filters) : $output(false);
  });
  return $resolve({
    routes: aws.ec2.getRouteTableOutput({ routeTableId }).routes,
    local: probe('local'),
    lattice: probe('lattice'),
    propagated: probe('propagated'),
    endpoint: probe('endpoint'),
    created: probe('created'),
    networkInterface: probe('networkInterface'),
    otherPrefixList,
    data: dataEndpoint,
  }).apply(({ routes, data, ...probes }) => tableRoutes(routes, probes, routeTableId, data));
}

/** The subnets in CALLABLE_FUNCTION_SUBNET_IDS; the deploy fails unless subnetNetworkFaults finds none. */
function namedNetwork(subnetIds: string[]) {
  const dataEndpoint = $output(namedDataEndpointId ? dataEndpointOf(namedDataEndpointId) : undefined);
  const prefixListIds = aws.ec2.getManagedPrefixListsOutput({}).ids;
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
      routes: routeTableId.apply(id => routesOf(id, dataEndpoint, prefixListIds)),
    });
  });
  const lookups = $util.all([$resolve(subnets), dataEndpoint, S3_SERVICE_NAME, aws.getPartitionOutput().partition]);
  const checked = lookups.apply(([network, endpoint, s3ServiceName, partition]) => {
    const faults = subnetNetworkFaults(network, endpoint && { endpoint, s3ServiceName, partition });
    if (faults.length > 0) throw new Error(`CALLABLE_FUNCTION_SUBNET_IDS: ${faults.join('; ')}.`);
    return network;
  });
  return {
    vpcId: checked.apply(read => read[0].vpcId!),
    subnetIds: checked.apply(read => read.map(subnet => subnet.subnetId)),
    dataEndpoint: undefined,
  };
}

function createCallableFunctionRuntime() {
  // infra/callableFunctionData.ts creates the bucket exactly when no subnets are named.
  const network = callableFunctionDataBucket
    ? dedicatedNetwork(callableFunctionDataBucket)
    : namedNetwork(namedSubnetIds);
  const { dataEndpoint } = network;

  const securityGroup = new aws.ec2.SecurityGroup('CallableFunctionRuntimeSecurityGroup', {
    vpcId: network.vpcId,
    description: dataEndpoint
      ? 'Callable function runtime: no ingress, egress to the function-data endpoint only'
      : 'Callable function runtime: no ingress, no egress',
    ingress: [],
    egress: dataEndpoint
      ? [{ protocol: 'tcp', fromPort: 443, toPort: 443, prefixListIds: [dataEndpoint.prefixListId] }]
      : [],
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
      // Lambda refuses a reservation that leaves the account under 100 unreserved, so only production and dev reserve.
      reservedConcurrentExecutions: longLivedStage ? CALLABLE_FUNCTION_LAMBDA_RESERVED_CONCURRENCY : undefined,
      tenancyConfig: { tenantIsolationMode: 'PER_TENANT' },
      vpcConfig: {
        subnetIds: network.subnetIds,
        securityGroupIds: [securityGroup.id],
      },
      loggingConfig: { logFormat: 'Text', logGroup: logGroup.name },
    },
    { dependsOn: [rolePolicy] }
  );

  return { fn, subnetIds: network.subnetIds, dataEndpointId: dataEndpoint?.id };
}

/** Errors, duration, and throttles, in the shape infra/alarms.ts uses for its Lambda alarms. */
export function createCallableFunctionRuntimeAlarms(fn: aws.lambda.Function, topic: aws.sns.Topic | sst.aws.SnsTopic) {
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

type RuntimeGrant = {
  environment: Record<string, $util.Output<string>>;
  permissions: Array<{ actions: string[]; resources: $util.Output<string>[] }>;
};

/**
 * Each function that runs callable functions: the runtime's name to invoke and the grant to invoke it. Empty without a
 * runtime, so packages/server-utils/src/callableFunctions/runtimeRunner.ts finds no runner and a run is refused.
 */
export const callableFunctionRuntimeForCallers: RuntimeGrant = callableFunctionRuntime
  ? {
      environment: { CALLABLE_FUNCTION_RUNTIME_FUNCTION_NAME: callableFunctionRuntime.name },
      permissions: [{ actions: ['lambda:InvokeFunction'], resources: [callableFunctionRuntime.arn] }],
    }
  : { environment: {}, permissions: [] };

/** For the stack output: another stage in the same account runs the function in these subnets. */
export const callableFunctionSubnetIds = runtime?.subnetIds.apply(ids => ids.join(','));

/** For the stack output: such a stage sets it as CALLABLE_FUNCTION_DATA_ENDPOINT_ID. Only a dedicated network has one. */
export const callableFunctionDataEndpointId = runtime?.dataEndpointId;
