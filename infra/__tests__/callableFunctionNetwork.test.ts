/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import {
  callableFunctionRolePolicy,
  DEDICATED_SUBNET_CIDRS,
  distinctZones,
  LAMBDA_NETWORK_INTERFACE_ACTIONS,
  probeMatched,
  routeProbeFilters,
  subnetNetworkFaults,
  tableRoutes,
  type RouteProbes,
  type RouteTarget,
  type SubnetNetwork,
} from '../callableFunctionNetwork';

const LOCAL: RouteTarget = { gatewayId: 'local' };

const probes = (found: Partial<RouteProbes> = {}): RouteProbes => ({
  local: false,
  lattice: false,
  propagated: false,
  endpoint: false,
  created: false,
  ...found,
});

const subnet = (overrides: Partial<SubnetNetwork> = {}): SubnetNetwork => ({
  subnetId: 'subnet-0a',
  vpcId: 'vpc-0a',
  enableDnsSupport: false,
  routeTableId: 'rtb-0a',
  routes: [LOCAL],
  ...overrides,
});

describe('subnetNetworkFaults', () => {
  it('passes a subnet whose VPC has DNS support off and whose table holds only the local route', () => {
    expect(subnetNetworkFaults([subnet(), subnet({ subnetId: 'subnet-0b', routes: [LOCAL, LOCAL] })])).toEqual([]);
  });

  it.each<[string, RouteTarget]>([
    ['a NAT gateway', { natGatewayId: 'nat-0a' }],
    ['an internet gateway', { gatewayId: 'igw-0a' }],
    ['a transit gateway', { transitGatewayId: 'tgw-0a' }],
    ['an egress-only internet gateway', { egressOnlyGatewayId: 'eigw-0a' }],
    ['a peering connection', { vpcPeeringConnectionId: 'pcx-0a' }],
    ['a gateway endpoint', { gatewayId: 'vpce-0a', destinationPrefixListId: 'pl-0a' }],
    ['a virtual private gateway', { origin: 'EnableVgwRoutePropagation' }],
    ['a network interface', { networkInterfaceId: 'eni-0a' }],
    ['a route added to the table', { origin: 'CreateRoute' }],
    ['gateway VpcLattice', { gatewayId: 'VpcLattice' }],
    ['an unknown target', {}],
  ])('refuses a route to %s', (name, route) => {
    expect(subnetNetworkFaults([subnet({ routes: [LOCAL, route] })])).toEqual([
      `subnet subnet-0a: route table rtb-0a has a route to ${name}`,
    ]);
  });

  it('refuses DNS support on, and DNS support it could not read', () => {
    expect(subnetNetworkFaults([subnet({ enableDnsSupport: true })])).toEqual([
      'subnet subnet-0a: VPC vpc-0a has DNS support on',
    ]);
    expect(subnetNetworkFaults([subnet({ enableDnsSupport: undefined })])).toEqual([
      'subnet subnet-0a: VPC vpc-0a did not report DNS support',
    ]);
  });

  it('refuses every empty lookup', () => {
    expect(subnetNetworkFaults([])).toEqual(['no subnet is named']);
    expect(subnetNetworkFaults([subnet({ routes: [] })])).toEqual([
      'subnet subnet-0a: route table rtb-0a returned no routes',
    ]);
    expect(subnetNetworkFaults([subnet({ routeTableId: undefined })])).toEqual([
      'subnet subnet-0a: no route table was found for it',
    ]);
    expect(subnetNetworkFaults([subnet({ vpcId: undefined })])).toEqual(['subnet subnet-0a: its VPC was not found']);
  });

  it('refuses subnets in two VPCs', () => {
    expect(subnetNetworkFaults([subnet(), subnet({ subnetId: 'subnet-0b', vpcId: 'vpc-0b' })])).toEqual([
      'the subnets are in more than one VPC (vpc-0a, vpc-0b)',
    ]);
  });
});

describe('tableRoutes', () => {
  const faultsOf = (listed: RouteTarget[], found: Partial<RouteProbes>) =>
    subnetNetworkFaults([subnet({ routes: tableRoutes(listed, probes(found)) })]);

  it('passes a table whose only route is the local route the data source omits', () => {
    expect(faultsOf([], { local: true })).toEqual([]);
  });

  it('refuses a gateway endpoint route the data source omits', () => {
    expect(faultsOf([], { local: true, endpoint: true })).toEqual([
      'subnet subnet-0a: route table rtb-0a has a route to a gateway endpoint',
    ]);
  });

  it('refuses a propagated route the data source omits', () => {
    expect(faultsOf([], { local: true, propagated: true })).toEqual([
      'subnet subnet-0a: route table rtb-0a has a route to a virtual private gateway',
    ]);
  });

  it('refuses a VpcLattice route and a hand-added route the data source omits', () => {
    expect(faultsOf([], { local: true, lattice: true })).toEqual([
      'subnet subnet-0a: route table rtb-0a has a route to gateway VpcLattice',
    ]);
    expect(faultsOf([], { local: true, created: true })).toEqual([
      'subnet subnet-0a: route table rtb-0a has a route to a route added to the table',
    ]);
  });

  it('keeps a listed route next to the probed routes', () => {
    expect(faultsOf([{ natGatewayId: 'nat-0a' }], { local: true })).toEqual([
      'subnet subnet-0a: route table rtb-0a has a route to a NAT gateway',
    ]);
    expect(tableRoutes([{ natGatewayId: 'nat-0a' }], probes({ local: true }))).toEqual([
      { natGatewayId: 'nat-0a' },
      LOCAL,
    ]);
  });

  it('refuses a table with nothing listed and no local route', () => {
    expect(faultsOf([], { local: false })).toEqual(['subnet subnet-0a: route table rtb-0a returned no routes']);
  });
});

describe('route probe lookups', () => {
  it.each<[keyof RouteProbes, { name: string; values: string[] }]>([
    ['local', { name: 'route.gateway-id', values: ['local'] }],
    ['lattice', { name: 'route.gateway-id', values: ['VpcLattice'] }],
    ['propagated', { name: 'route.origin', values: ['EnableVgwRoutePropagation'] }],
    ['endpoint', { name: 'route.gateway-id', values: ['vpce-*'] }],
    ['created', { name: 'route.origin', values: ['CreateRoute'] }],
  ])('filters the %s probe to the one table and its kind of route', (probe, filter) => {
    expect(routeProbeFilters('rtb-0a', probe)).toEqual([{ name: 'route-table-id', values: ['rtb-0a'] }, filter]);
  });

  it('counts a probe as matched when the lookup returned the table', () => {
    expect(probeMatched([])).toBe(false);
    expect(probeMatched(['rtb-0a'])).toBe(true);
    expect(probeMatched(['rtb-0a', 'rtb-0b'])).toBe(true);
  });
});

describe('dedicated subnets', () => {
  it('has two subnets with different CIDRs', () => {
    expect(DEDICATED_SUBNET_CIDRS).toHaveLength(2);
    expect(new Set(DEDICATED_SUBNET_CIDRS).size).toBe(2);
  });

  it('takes one distinct zone per subnet and fails on a region with fewer', () => {
    expect(distinctZones(['use1-az1', 'use1-az2', 'use1-az4'], 2)).toEqual(['use1-az1', 'use1-az2']);
    expect(distinctZones(['use1-az1', 'use1-az1', 'use1-az2'], 2)).toEqual(['use1-az1', 'use1-az2']);
    expect(() => distinctZones(['use1-az1', 'use1-az1'], 2)).toThrow('1 usable zones found');
    expect(() => distinctZones([], 2)).toThrow('0 usable zones found');
  });
});

describe('callableFunctionRolePolicy', () => {
  const policy = callableFunctionRolePolicy('runtime-log-group');

  it('grants the managed policy network-interface actions and log writes to its own log group only', () => {
    expect(policy.Statement).toEqual([
      { Sid: 'NetworkInterfaces', Effect: 'Allow', Action: LAMBDA_NETWORK_INTERFACE_ACTIONS, Resource: '*' },
      {
        Sid: 'OwnLogGroup',
        Effect: 'Allow',
        Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        Resource: 'runtime-log-group:*',
      },
    ]);
  });
});
