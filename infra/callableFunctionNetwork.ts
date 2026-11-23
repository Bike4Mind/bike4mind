// The callable function runtime's network layout, route check, and role policy (infra/callableFunctionRuntime.ts).
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

/** One subnet per CIDR, each in its own zone, all on the one empty route table. */
export const DEDICATED_SUBNET_CIDRS = ['10.0.0.0/20', '10.0.16.0/20'];

/** The first `count` distinct zones; throws when the region offers fewer. */
export function distinctZones(zoneIds: string[], count: number): string[] {
  const zones = [...new Set(zoneIds)].slice(0, count);
  if (zones.length < count) throw new Error(`${zones.length} usable zones found; the runtime needs ${count}.`);
  return zones;
}

/** Whether each filtered route table lookup found the table; one lookup per kind of route the data source omits. */
export interface RouteProbes {
  local: boolean;
  lattice: boolean;
  propagated: boolean;
  endpoint: boolean;
  created: boolean;
}

const ROUTE_PROBES: Record<keyof RouteProbes, { filter: { name: string; values: string[] }; route: RouteTarget }> = {
  local: { filter: { name: 'route.gateway-id', values: ['local'] }, route: { gatewayId: 'local' } },
  lattice: { filter: { name: 'route.gateway-id', values: ['VpcLattice'] }, route: { gatewayId: 'VpcLattice' } },
  propagated: {
    filter: { name: 'route.origin', values: ['EnableVgwRoutePropagation'] },
    route: { origin: 'EnableVgwRoutePropagation' },
  },
  endpoint: { filter: { name: 'route.gateway-id', values: ['vpce-*'] }, route: { gatewayId: 'vpce-*' } },
  created: { filter: { name: 'route.origin', values: ['CreateRoute'] }, route: { origin: 'CreateRoute' } },
};

/** The `getRouteTables` filters that match `routeTableId` only when its table holds a route of the probed kind. */
export function routeProbeFilters(routeTableId: string, probe: keyof RouteProbes) {
  return [{ name: 'route-table-id', values: [routeTableId] }, ROUTE_PROBES[probe].filter];
}

/** A probe lookup's result: the kind of route is in the table when the lookup returned the table. */
export const probeMatched = (ids: string[]): boolean => ids.length > 0;

/** The table's listed routes plus one route for each probe that matched. */
export function tableRoutes(listed: RouteTarget[], probes: RouteProbes): RouteTarget[] {
  const found = (Object.keys(ROUTE_PROBES) as Array<keyof RouteProbes>).filter(probe => probes[probe]);
  return [...listed, ...found.map(probe => ROUTE_PROBES[probe].route)];
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
 * subnet's route table holds the local route and nothing else.
 */
export function subnetNetworkFaults(subnets: SubnetNetwork[]): string[] {
  if (subnets.length === 0) return ['no subnet is named'];
  const faults: string[] = [];
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
      if (target !== 'local') faults.push(`subnet ${subnetId}: route table ${routeTableId} has a route to ${target}`);
    }
  }
  const vpcIds = new Set(subnets.map(subnet => subnet.vpcId).filter(Boolean));
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
