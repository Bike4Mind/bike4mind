// The callable function runtime's network layout, route check, role policy, and function-data policies
// (infra/callableFunctionRuntime.ts, infra/callableFunctionData.ts).
// Imports nothing and uses no sst global, so its test loads it outside `sst`.

/** One route's targets, named as the route table data source names them; an unset target is empty. */
export interface RouteTarget {
  gatewayId?: string;
  natGatewayId?: string;
  transitGatewayId?: string;
  egressOnlyGatewayId?: string;
  vpcPeeringConnectionId?: string;
  vpcEndpointId?: string;
  networkInterfaceId?: string;
  instanceId?: string;
  carrierGatewayId?: string;
  localGatewayId?: string;
  coreNetworkArn?: string;
  destinationPrefixListId?: string;
  /** `EnableVgwRoutePropagation` on a route propagated from a virtual private gateway. */
  origin?: string;
}

/** What the deploy read about one subnet named in CALLABLE_FUNCTION_SUBNET_IDS. */
export interface SubnetNetwork {
  subnetId: string;
  vpcId?: string;
  enableDnsSupport?: boolean;
  /** The table explicitly associated with the subnet, else its VPC's main table. */
  routeTableId?: string;
  /** Every route in that table, the local route included. */
  routes: RouteTarget[];
}

const GATEWAY_PREFIXES: Array<[string, string]> = [
  ['vpce-', 'a gateway endpoint'],
  ['igw-', 'an internet gateway'],
  ['vgw-', 'a virtual private gateway'],
];

const TARGET_FIELDS: Array<[Exclude<keyof RouteTarget, 'origin'>, string]> = [
  ['natGatewayId', 'a NAT gateway'],
  ['transitGatewayId', 'a transit gateway'],
  ['egressOnlyGatewayId', 'an egress-only internet gateway'],
  ['vpcPeeringConnectionId', 'a peering connection'],
  ['vpcEndpointId', 'a VPC endpoint'],
  ['networkInterfaceId', 'a network interface'],
  ['instanceId', 'an instance'],
  ['carrierGatewayId', 'a carrier gateway'],
  ['localGatewayId', 'a local gateway'],
  ['coreNetworkArn', 'a core network'],
  ['destinationPrefixListId', 'a prefix list'],
];

/** The subnet ids in a CALLABLE_FUNCTION_SUBNET_IDS value. */
export function namedSubnetIdsOf(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);
}

/** One subnet per CIDR, each in its own zone, all on the one empty route table. */
export const DEDICATED_SUBNET_CIDRS = ['10.0.0.0/20', '10.0.16.0/20'];

/** The first `count` distinct zones; throws when the region offers fewer. */
export function distinctZones(zoneIds: string[], count: number): string[] {
  const zones = [...new Set(zoneIds)].slice(0, count);
  if (zones.length < count) throw new Error(`${zones.length} usable zones found; the runtime needs ${count}.`);
  return zones;
}

/** What the deploy read about the endpoint named in CALLABLE_FUNCTION_DATA_ENDPOINT_ID. */
export interface DataEndpoint {
  id: string;
  vpcId?: string;
  vpcEndpointType?: string;
  serviceName?: string;
  state?: string;
  prefixListId?: string;
  routeTableIds: string[];
  policy?: string;
}

/** Whether each filtered route table lookup found the table; one lookup per kind of route the data source omits. */
export interface RouteProbes {
  local: boolean;
  lattice: boolean;
  propagated: boolean;
  endpoint: boolean;
  created: boolean;
  networkInterface: boolean;
  /** A route to any prefix list but the data endpoint's; see otherPrefixListFilters. */
  otherPrefixList: boolean;
}

export type FixedProbe = Exclude<keyof RouteProbes, 'otherPrefixList'>;

const ROUTE_PROBES: Record<FixedProbe, { filter: { name: string; values: string[] }; route: RouteTarget }> = {
  local: { filter: { name: 'route.gateway-id', values: ['local'] }, route: { gatewayId: 'local' } },
  lattice: { filter: { name: 'route.gateway-id', values: ['VpcLattice'] }, route: { gatewayId: 'VpcLattice' } },
  propagated: {
    filter: { name: 'route.origin', values: ['EnableVgwRoutePropagation'] },
    route: { origin: 'EnableVgwRoutePropagation' },
  },
  endpoint: { filter: { name: 'route.gateway-id', values: ['vpce-*'] }, route: { gatewayId: 'vpce-*' } },
  created: { filter: { name: 'route.origin', values: ['CreateRoute'] }, route: { origin: 'CreateRoute' } },
  networkInterface: {
    filter: { name: 'route.network-interface-id', values: ['eni-*'] },
    route: { networkInterfaceId: 'eni-*' },
  },
};

/** The `getRouteTables` filters that match `routeTableId` only when its table holds a route of the probed kind. */
export function routeProbeFilters(routeTableId: string, probe: FixedProbe) {
  return [{ name: 'route-table-id', values: [routeTableId] }, ROUTE_PROBES[probe].filter];
}

/**
 * Filters matching the table when it routes to any visible prefix list but `exceptId`; undefined when there is none
 * to look for. A table holds one route per destination, so with the data endpoint's prefix list excepted this finds
 * every other endpoint route.
 */
export function otherPrefixListFilters(routeTableId: string, prefixListIds: string[], exceptId?: string) {
  const values = prefixListIds.filter(id => id !== exceptId);
  if (values.length === 0) return undefined;
  return [
    { name: 'route-table-id', values: [routeTableId] },
    { name: 'route.destination-prefix-list-id', values },
  ];
}

/** A probe lookup's result: the kind of route is in the table when the lookup returned the table. */
export const probeMatched = (ids: string[]): boolean => ids.length > 0;

const OTHER_PREFIX_LIST_ROUTE: RouteTarget = { destinationPrefixListId: 'pl-*' };

/**
 * The table's listed routes plus one route for each probe that matched. An endpoint route counts as the data
 * endpoint's own route when that endpoint lists the table; any other endpoint route matches `otherPrefixList`.
 */
export function tableRoutes(
  listed: RouteTarget[],
  probes: RouteProbes,
  routeTableId?: string,
  dataEndpoint?: DataEndpoint
): RouteTarget[] {
  const dataRoute =
    routeTableId && dataEndpoint?.routeTableIds.includes(routeTableId)
      ? { gatewayId: dataEndpoint.id, destinationPrefixListId: dataEndpoint.prefixListId }
      : undefined;
  // The endpoint route itself may read back with origin CreateRoute. Every other route the data source omits has a
  // probe of its own, so `created` adds nothing once the data route is accounted for.
  const skipCreated = !!dataRoute && probes.endpoint;
  const found = (Object.keys(ROUTE_PROBES) as FixedProbe[]).filter(
    probe => probes[probe] && !(probe === 'created' && skipCreated)
  );
  const probed = found.map(probe => (probe === 'endpoint' && dataRoute ? dataRoute : ROUTE_PROBES[probe].route));
  return [...listed, ...probed, ...(probes.otherPrefixList ? [OTHER_PREFIX_LIST_ROUTE] : [])];
}

/** Every function-data key starts with it; must match callableFunctionDataKey (packages/server-utils). */
export const FUNCTION_DATA_KEY_PREFIX = 'data/';

/** Live source fetches, expired after a day; must match CALLABLE_FUNCTION_LIVE_SOURCE_KEY_PREFIX (server-utils). */
export const FUNCTION_LIVE_SOURCE_KEY_PREFIX = `${FUNCTION_DATA_KEY_PREFIX}.live/`;

const BUCKET_DATA_OBJECTS = /^[a-z0-9][a-z0-9.-]*\/data\/\*$/;
const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : [value]);

/** True only for one Allow statement of `s3:GetObject` on one bucket's `data/` objects, for any principal. */
export function isGetObjectOnlyPolicy(policy: string | undefined, partition: string): boolean {
  let document: unknown;
  try {
    document = JSON.parse(policy ?? '');
  } catch {
    return false;
  }
  if (typeof document !== 'object' || document === null) return false;
  const statements = asList((document as Record<string, unknown>).Statement);
  if (statements.length !== 1 || typeof statements[0] !== 'object' || statements[0] === null) return false;
  const statement = statements[0] as Record<string, unknown>;
  const principal = statement.Principal;
  const resources = asList(statement.Resource);
  return (
    Object.keys(statement).every(key => ['Sid', 'Effect', 'Principal', 'Action', 'Resource'].includes(key)) &&
    statement.Effect === 'Allow' &&
    (principal === '*' || JSON.stringify(principal) === '{"AWS":"*"}') &&
    JSON.stringify(asList(statement.Action)) === '["s3:GetObject"]' &&
    resources.length === 1 &&
    typeof resources[0] === 'string' &&
    partition !== '' &&
    resources[0].startsWith(`arn:${partition}:s3:::`) &&
    BUCKET_DATA_OBJECTS.test(resources[0].slice(`arn:${partition}:s3:::`.length))
  );
}

/** Why the endpoint in CALLABLE_FUNCTION_DATA_ENDPOINT_ID cannot be the runtime's one route out of `vpcId`. */
function dataEndpointFaults(
  { id, ...endpoint }: DataEndpoint,
  { s3ServiceName, partition }: { s3ServiceName: string; partition: string },
  vpcId?: string
): string[] {
  const faults: string[] = [];
  if (endpoint.vpcEndpointType !== 'Gateway') faults.push(`endpoint ${id} is not a gateway endpoint`);
  if (endpoint.serviceName !== s3ServiceName) faults.push(`endpoint ${id} is not for ${s3ServiceName}`);
  if (endpoint.state?.toLowerCase() !== 'available') faults.push(`endpoint ${id} is not available`);
  if (vpcId && endpoint.vpcId !== vpcId) faults.push(`endpoint ${id} is not in VPC ${vpcId}`);
  if (!isGetObjectOnlyPolicy(endpoint.policy, partition)) {
    faults.push(`endpoint ${id} has a policy that allows more than s3:GetObject on one bucket's data objects`);
  }
  return faults;
}

/** `local` for the VPC's own route, otherwise what the route leads to. */
function routeTargetName(route: RouteTarget): string {
  if (route.origin === 'EnableVgwRoutePropagation') return 'a virtual private gateway';
  if (route.origin === 'CreateRoute') return 'a route added to the table';
  const gatewayId = route.gatewayId ?? '';
  for (const [prefix, name] of GATEWAY_PREFIXES) if (gatewayId.startsWith(prefix)) return name;
  for (const [field, name] of TARGET_FIELDS) if (route[field]) return name;
  if (gatewayId === 'local') return 'local';
  return gatewayId ? `gateway ${gatewayId}` : 'an unknown target';
}

/**
 * Why the named subnets cannot hold the function; empty only when they share one VPC with DNS support off and each
 * subnet's route table holds the local route and nothing else but, when `data` names one, that S3 gateway
 * endpoint's own prefix-list route.
 */
export function subnetNetworkFaults(
  subnets: SubnetNetwork[],
  data?: { endpoint: DataEndpoint; s3ServiceName: string; partition: string }
): string[] {
  if (subnets.length === 0) return ['no subnet is named'];
  const vpcIds = new Set(subnets.map(subnet => subnet.vpcId).filter(Boolean));
  const endpointFaults = data ? dataEndpointFaults(data.endpoint, data, [...vpcIds][0]) : [];
  const isDataRoute = (route: RouteTarget, routeTableId: string) =>
    !!data &&
    endpointFaults.length === 0 &&
    route.gatewayId === data.endpoint.id &&
    !!route.destinationPrefixListId &&
    route.destinationPrefixListId === data.endpoint.prefixListId &&
    data.endpoint.routeTableIds.includes(routeTableId);
  const faults: string[] = [...endpointFaults];
  for (const { subnetId, vpcId, enableDnsSupport, routeTableId, routes } of subnets) {
    if (!vpcId) faults.push(`subnet ${subnetId}: its VPC was not found`);
    else if (enableDnsSupport === true) faults.push(`subnet ${subnetId}: VPC ${vpcId} has DNS support on`);
    else if (enableDnsSupport !== false) faults.push(`subnet ${subnetId}: VPC ${vpcId} did not report DNS support`);
    if (!routeTableId) {
      faults.push(`subnet ${subnetId}: no route table was found for it`);
      continue;
    }
    if (routes.length === 0) faults.push(`subnet ${subnetId}: route table ${routeTableId} returned no routes`);
    for (const route of routes) {
      const target = routeTargetName(route);
      if (target !== 'local' && !isDataRoute(route, routeTableId)) {
        faults.push(`subnet ${subnetId}: route table ${routeTableId} has a route to ${target}`);
      }
    }
  }
  if (vpcIds.size > 1) faults.push(`the subnets are in more than one VPC (${[...vpcIds].join(', ')})`);
  return faults;
}

/** The network-interface actions of the AWSLambdaVPCAccessExecutionRole managed policy (v3). */
export const LAMBDA_NETWORK_INTERFACE_ACTIONS = [
  'ec2:CreateNetworkInterface',
  'ec2:DescribeNetworkInterfaces',
  'ec2:DescribeSubnets',
  'ec2:DeleteNetworkInterface',
  'ec2:AssignPrivateIpAddresses',
  'ec2:UnassignPrivateIpAddresses',
];

/** The runtime role's only policy: the network interfaces Lambda manages for it, and writes to its own log group. */
export function callableFunctionRolePolicy(logGroupArn: string) {
  return {
    Version: '2012-10-17',
    Statement: [
      { Sid: 'NetworkInterfaces', Effect: 'Allow', Action: LAMBDA_NETWORK_INTERFACE_ACTIONS, Resource: '*' },
      {
        Sid: 'OwnLogGroup',
        Effect: 'Allow',
        Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        Resource: `${logGroupArn}:*`,
      },
    ],
  };
}

/** The data endpoint's policy: GetObject on the function-data bucket's `data/` objects, for any principal. */
export function callableFunctionDataEndpointPolicy(bucketArn: string) {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'FunctionDataReads',
        Effect: 'Allow',
        Principal: '*',
        Action: 's3:GetObject',
        Resource: `${bucketArn}/${FUNCTION_DATA_KEY_PREFIX}*`,
      },
    ],
  };
}

/** What the web API function's role may do to the function-data bucket's `data/` objects. */
export const FUNCTION_DATA_DISPATCHER_ACTIONS = ['s3:PutObject', 's3:GetObject', 's3:DeleteObject'];

/** What the account-erasure worker's and the account-deletion sweep's roles may do, beside listing the keys. */
export const FUNCTION_DATA_ERASER_ACTIONS = ['s3:DeleteObject'];

export const FUNCTION_DATA_READ_ACTIONS = ['s3:GetObject*'];
export const FUNCTION_DATA_LIST_ACTIONS = ['s3:ListBucket*'];
export const FUNCTION_DATA_WRITE_ACTIONS = ['s3:PutObject*', 's3:Replicate*'];
export const FUNCTION_DATA_DELETE_ACTIONS = ['s3:DeleteObject*'];

/** What the browser-link reader role may do: read the function-data bucket's `data/` objects, nothing else. */
export const FUNCTION_DATA_BROWSER_READER_ACTIONS = ['s3:GetObject'];

/**
 * How long a browser-link reader's signed link works: the owner's browser reads its own pinned file at once
 * (CALLABLE_FUNCTION_DATA_BROWSER_LINK_SECONDS in packages/server-utils dataPins.ts). In ms.
 */
export const FUNCTION_DATA_BROWSER_LINK_WINDOW_MS = 60_000;

/** The browser-link reader role's only policy. */
export function callableFunctionDataBrowserReaderPolicy(bucketArn: string) {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'FunctionDataBrowserReads',
        Effect: 'Allow',
        Action: FUNCTION_DATA_BROWSER_READER_ACTIONS,
        Resource: `${bucketArn}/${FUNCTION_DATA_KEY_PREFIX}*`,
      },
    ],
  };
}

/** Who may assume the browser-link reader role: the web API function's role, which serves the owner's read route. */
export function callableFunctionDataBrowserReaderTrustPolicy(serverRoleArn: string) {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'WebApiFunctionOnly',
        Effect: 'Allow',
        Principal: { AWS: serverRoleArn },
        Action: 'sts:AssumeRole',
      },
    ],
  };
}

/**
 * The function-data bucket's policy: HTTPS only; reads by the dispatcher's role and the browser-link reader's;
 * object writes by the dispatcher's role only; listing and deletes by it and the eraser roles (account erasure and
 * the deletion sweep). Signed links work only through `endpointId`, but the browser-link reader's, which work from
 * anywhere for their first minute.
 */
export function callableFunctionDataBucketPolicy({
  bucketArn,
  dispatcherRoleArn,
  browserReaderRoleArn,
  eraserRoleArns = [],
  endpointId,
}: {
  bucketArn: string;
  dispatcherRoleArn: string;
  browserReaderRoleArn: string;
  eraserRoleArns?: string[];
  endpointId?: string;
}) {
  const erasers = eraserRoleArns.filter(Boolean);
  const notDispatcher = { ArnNotEquals: { 'aws:PrincipalArn': dispatcherRoleArn } };
  const notDispatcherOrReader = { ArnNotEquals: { 'aws:PrincipalArn': [dispatcherRoleArn, browserReaderRoleArn] } };
  // A prefix delete lists the keys first, so erasers pass the list and delete denies, never the read or write ones.
  const notDispatcherOrEraser = {
    ArnNotEquals: { 'aws:PrincipalArn': erasers.length ? [dispatcherRoleArn, ...erasers] : dispatcherRoleArn },
  };
  const notThroughEndpoint = endpointId ? { StringNotEquals: { 'aws:SourceVpce': endpointId } } : {};
  const signedLink = { StringEquals: { 's3:authType': 'REST-QUERY-STRING' } };
  const pastBrowserWindow = { NumericGreaterThan: { 's3:signatureAge': String(FUNCTION_DATA_BROWSER_LINK_WINDOW_MS) } };
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'HttpsOnly',
        Effect: 'Deny',
        Principal: '*',
        Action: 's3:*',
        Resource: [bucketArn, `${bucketArn}/*`],
        Condition: { Bool: { 'aws:SecureTransport': 'false' } },
      },
      {
        Sid: 'ReadsByDispatcherAndBrowserReader',
        Effect: 'Deny',
        Principal: '*',
        Action: FUNCTION_DATA_READ_ACTIONS,
        Resource: `${bucketArn}/*`,
        Condition: notDispatcherOrReader,
      },
      {
        Sid: 'ListByDispatcherAndErasers',
        Effect: 'Deny',
        Principal: '*',
        Action: FUNCTION_DATA_LIST_ACTIONS,
        Resource: bucketArn,
        Condition: notDispatcherOrEraser,
      },
      {
        Sid: 'SignedLinksThroughDataEndpoint',
        Effect: 'Deny',
        Principal: '*',
        Action: 's3:GetObject*',
        Resource: `${bucketArn}/*`,
        Condition: {
          ...signedLink,
          ...notThroughEndpoint,
          ArnNotEquals: { 'aws:PrincipalArn': browserReaderRoleArn },
        },
      },
      {
        Sid: 'BrowserReaderLinksForOneMinute',
        Effect: 'Deny',
        Principal: '*',
        Action: 's3:GetObject*',
        Resource: `${bucketArn}/*`,
        Condition: { ArnEquals: { 'aws:PrincipalArn': browserReaderRoleArn }, ...pastBrowserWindow },
      },
      {
        Sid: 'WritesByDispatcher',
        Effect: 'Deny',
        Principal: '*',
        Action: FUNCTION_DATA_WRITE_ACTIONS,
        Resource: `${bucketArn}/*`,
        Condition: notDispatcher,
      },
      {
        Sid: 'DeletesByDispatcherAndErasers',
        Effect: 'Deny',
        Principal: '*',
        Action: FUNCTION_DATA_DELETE_ACTIONS,
        Resource: `${bucketArn}/*`,
        Condition: notDispatcherOrEraser,
      },
    ],
  };
}
