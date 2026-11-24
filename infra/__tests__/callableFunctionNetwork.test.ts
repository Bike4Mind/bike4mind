/**
 * @vitest-environment node
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  callableFunctionDataBucketPolicy,
  callableFunctionDataEndpointPolicy,
  callableFunctionRolePolicy,
  DEDICATED_SUBNET_CIDRS,
  distinctZones,
  FUNCTION_DATA_DISPATCHER_ACTIONS,
  isGetObjectOnlyPolicy,
  LAMBDA_NETWORK_INTERFACE_ACTIONS,
  otherPrefixListFilters,
  probeMatched,
  routeProbeFilters,
  subnetNetworkFaults,
  tableRoutes,
  type DataEndpoint,
  type FixedProbe,
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
  otherPrefixList: false,
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
  it.each<[FixedProbe, { name: string; values: string[] }]>([
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

const providerPartition = () => String(aws.getPartitionOutput().partition);
vi.stubGlobal('aws', { getPartitionOutput: () => ({ partition: 'aws' }) });
const PARTITION = providerPartition();
afterEach(() => vi.unstubAllGlobals());

const BUCKET = 'function-data-bucket';
const BUCKET_ARN = `arn:${PARTITION}:s3:::${BUCKET}`;
const S3 = 'com.amazonaws.region-1.s3';
const ENDPOINT: DataEndpoint = {
  id: 'vpce-0data',
  vpcId: 'vpc-0a',
  vpcEndpointType: 'Gateway',
  serviceName: S3,
  state: 'available',
  prefixListId: 'pl-0s3',
  routeTableIds: ['rtb-0a'],
  policy: JSON.stringify(callableFunctionDataEndpointPolicy(BUCKET_ARN)),
};
const DATA_ROUTE: RouteTarget = { gatewayId: 'vpce-0data', destinationPrefixListId: 'pl-0s3' };

describe('the function-data endpoint route', () => {
  const faultsWith = (routes: RouteTarget[], endpoint: Partial<DataEndpoint> = {}) =>
    subnetNetworkFaults([subnet({ routes })], {
      endpoint: { ...ENDPOINT, ...endpoint },
      s3ServiceName: S3,
      partition: PARTITION,
    });

  it("accepts the named endpoint's S3 prefix-list route next to the local route", () => {
    expect(faultsWith([LOCAL, DATA_ROUTE])).toEqual([]);
  });

  it('accepts it as the probes read it, with the data source omitting both routes', () => {
    const routes = tableRoutes([], probes({ local: true, endpoint: true }), 'rtb-0a', ENDPOINT);
    expect(routes).toEqual([LOCAL, DATA_ROUTE]);
    expect(faultsWith(routes)).toEqual([]);
  });

  it('refuses the same route when no endpoint is named', () => {
    expect(subnetNetworkFaults([subnet({ routes: [LOCAL, DATA_ROUTE] })])).toEqual([
      'subnet subnet-0a: route table rtb-0a has a route to a gateway endpoint',
    ]);
  });

  it.each<[string, RouteTarget, string]>([
    ['another endpoint id', { gatewayId: 'vpce-0other', destinationPrefixListId: 'pl-0s3' }, 'a gateway endpoint'],
    ['another prefix list', { gatewayId: 'vpce-0data', destinationPrefixListId: 'pl-0other' }, 'a gateway endpoint'],
    ['no prefix list', { gatewayId: 'vpce-0data' }, 'a gateway endpoint'],
    ['a NAT gateway', { natGatewayId: 'nat-0a' }, 'a NAT gateway'],
    ['an internet gateway', { gatewayId: 'igw-0a' }, 'an internet gateway'],
    ['a transit gateway', { transitGatewayId: 'tgw-0a' }, 'a transit gateway'],
    ['a peering connection', { vpcPeeringConnectionId: 'pcx-0a' }, 'a peering connection'],
    ['a propagated route', { origin: 'EnableVgwRoutePropagation' }, 'a virtual private gateway'],
    ['a route added to the table', { origin: 'CreateRoute' }, 'a route added to the table'],
  ])('still refuses %s with the endpoint named', (_case, route, name) => {
    expect(faultsWith([LOCAL, DATA_ROUTE, route])).toEqual([
      `subnet subnet-0a: route table rtb-0a has a route to ${name}`,
    ]);
  });

  it("refuses the endpoint's route in a table the endpoint does not list", () => {
    expect(faultsWith([LOCAL, DATA_ROUTE], { routeTableIds: ['rtb-0b'] })).toEqual([
      'subnet subnet-0a: route table rtb-0a has a route to a gateway endpoint',
    ]);
  });

  it('refuses another endpoint route the probes find next to the accepted one', () => {
    const routes = tableRoutes([], probes({ local: true, endpoint: true, otherPrefixList: true }), 'rtb-0a', ENDPOINT);
    expect(faultsWith(routes)).toEqual(['subnet subnet-0a: route table rtb-0a has a route to a prefix list']);
  });

  it('refuses an endpoint route the probes find in a table the endpoint does not list', () => {
    const routes = tableRoutes([], probes({ local: true, endpoint: true }), 'rtb-0b', ENDPOINT);
    const data = { endpoint: ENDPOINT, s3ServiceName: S3, partition: PARTITION };
    expect(subnetNetworkFaults([subnet({ routeTableId: 'rtb-0b', routes })], data)).toEqual([
      'subnet subnet-0a: route table rtb-0b has a route to a gateway endpoint',
    ]);
  });

  it.each<[string, Partial<DataEndpoint>, string]>([
    ['an interface endpoint', { vpcEndpointType: 'Interface' }, 'endpoint vpce-0data is not a gateway endpoint'],
    ['another service', { serviceName: 'com.amazonaws.region-1.dynamodb' }, `endpoint vpce-0data is not for ${S3}`],
    ['an endpoint not available', { state: 'pending' }, 'endpoint vpce-0data is not available'],
    ['an endpoint in another VPC', { vpcId: 'vpc-0b' }, 'endpoint vpce-0data is not in VPC vpc-0a'],
    [
      'a wider endpoint policy',
      { policy: JSON.stringify({ Statement: [{ Effect: 'Allow', Principal: '*', Action: 's3:*', Resource: '*' }] }) },
      'endpoint vpce-0data has a policy that allows more than s3:GetObject on one bucket',
    ],
  ])('refuses %s and its route', (_case, endpoint, fault) => {
    expect(faultsWith([LOCAL, DATA_ROUTE], endpoint)).toEqual([
      fault,
      'subnet subnet-0a: route table rtb-0a has a route to a gateway endpoint',
    ]);
  });

  it("looks for every prefix list but the endpoint's, and skips the lookup when none is left", () => {
    expect(otherPrefixListFilters('rtb-0a', ['pl-0s3', 'pl-0db', 'pl-0own'], 'pl-0s3')).toEqual([
      { name: 'route-table-id', values: ['rtb-0a'] },
      { name: 'route.destination-prefix-list-id', values: ['pl-0db', 'pl-0own'] },
    ]);
    expect(otherPrefixListFilters('rtb-0a', ['pl-0s3', 'pl-0db'])).toEqual([
      { name: 'route-table-id', values: ['rtb-0a'] },
      { name: 'route.destination-prefix-list-id', values: ['pl-0s3', 'pl-0db'] },
    ]);
    expect(otherPrefixListFilters('rtb-0a', ['pl-0s3'], 'pl-0s3')).toBeUndefined();
  });
});

describe('isGetObjectOnlyPolicy', () => {
  const statement = { Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: `${BUCKET_ARN}/*` };
  const policy = (...statements: object[]) => JSON.stringify({ Version: '2012-10-17', Statement: statements });

  it("passes the data endpoint's own policy, and its one-element-list form", () => {
    expect(isGetObjectOnlyPolicy(JSON.stringify(callableFunctionDataEndpointPolicy(BUCKET_ARN)), PARTITION)).toBe(true);
    const listed = { ...statement, Action: ['s3:GetObject'], Resource: [statement.Resource] };
    expect(isGetObjectOnlyPolicy(policy(listed), PARTITION)).toBe(true);
  });

  it('refuses a resource outside the partition the provider reports', () => {
    vi.stubGlobal('aws', { getPartitionOutput: () => ({ partition: 'aws-cn' }) });
    const reported = providerPartition();
    expect(reported).not.toBe(PARTITION);
    expect(isGetObjectOnlyPolicy(policy(statement), reported)).toBe(false);
    const inReported = { ...statement, Resource: statement.Resource.replace(`arn:${PARTITION}:`, `arn:${reported}:`) };
    expect(isGetObjectOnlyPolicy(policy(inReported), reported)).toBe(true);
    expect(isGetObjectOnlyPolicy(policy(inReported), PARTITION)).toBe(false);
  });

  it.each<[string, string | undefined]>([
    ['no policy', undefined],
    ['text that is not JSON', 'not json'],
    ['a second statement', policy(statement, statement)],
    ['a wider action', policy({ ...statement, Action: 's3:Get*' })],
    ['a second action', policy({ ...statement, Action: ['s3:GetObject', 's3:PutObject'] })],
    ['every bucket', policy({ ...statement, Resource: `arn:${PARTITION}:s3:::*/*` })],
    ['the bucket itself', policy({ ...statement, Resource: BUCKET_ARN })],
    ['two buckets', policy({ ...statement, Resource: [`${BUCKET_ARN}/*`, `${BUCKET_ARN}-other/*`] })],
    ['a NotAction', policy({ Effect: 'Allow', Principal: '*', NotAction: 's3:PutObject', Resource: '*' })],
    ['a Deny', policy({ ...statement, Effect: 'Deny' })],
  ])('refuses %s', (_case, text) => {
    expect(isGetObjectOnlyPolicy(text, PARTITION)).toBe(false);
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

  it('holds no S3 permission', () => {
    expect(JSON.stringify(policy)).not.toMatch(/s3/i);
  });
});

describe('callableFunctionDataEndpointPolicy', () => {
  it("allows GetObject on the bucket's objects and nothing else", () => {
    expect(callableFunctionDataEndpointPolicy(BUCKET_ARN)).toEqual({
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'FunctionDataReads',
          Effect: 'Allow',
          Principal: '*',
          Action: 's3:GetObject',
          Resource: `${BUCKET_ARN}/*`,
        },
      ],
    });
  });
});

describe('callableFunctionDataBucketPolicy', () => {
  const DISPATCHER = 'dispatcher-role-arn';
  const OTHER = 'other-role-arn';

  interface Request {
    action: string;
    principalArn?: string;
    sourceVpce?: string;
    secure?: boolean;
  }

  const matchesAction = (patterns: string | string[], action: string) =>
    [patterns].flat().some(pattern => new RegExp(`^${pattern.replace(/\*/g, '.*')}$`).test(action));

  // Each condition key compares one value; a missing key fails the equality and passes the negated test.
  const conditionHolds = (condition: Record<string, Record<string, string>> | undefined, request: Request) =>
    Object.entries(condition ?? {}).every(([test, pair]) =>
      Object.entries(pair).every(([key, value]) => {
        const actual = {
          'aws:PrincipalArn': request.principalArn,
          'aws:SourceVpce': request.sourceVpce,
          'aws:SecureTransport': String(request.secure ?? true),
        }[key];
        if (test === 'Bool') return actual === value;
        if (test === 'ArnNotEquals' || test === 'StringNotEquals') return actual !== value;
        throw new Error(`untested condition ${test}`);
      })
    );

  const denied = (policy: ReturnType<typeof callableFunctionDataBucketPolicy>, request: Request) =>
    policy.Statement.some(
      statement =>
        statement.Effect === 'Deny' &&
        matchesAction(statement.Action, request.action) &&
        conditionHolds(statement.Condition as Record<string, Record<string, string>>, request)
    );

  const withEndpoint = callableFunctionDataBucketPolicy({
    bucketArn: BUCKET_ARN,
    dispatcherRoleArn: DISPATCHER,
    endpointId: 'vpce-0data',
  });
  const withoutEndpoint = callableFunctionDataBucketPolicy({ bucketArn: BUCKET_ARN, dispatcherRoleArn: DISPATCHER });

  it('refuses every read from outside the endpoint, by any principal but the dispatcher', () => {
    for (const action of ['s3:GetObject', 's3:GetObjectVersion', 's3:GetObjectAttributes', 's3:ListBucket']) {
      expect(denied(withEndpoint, { action, principalArn: OTHER })).toBe(true);
      expect(denied(withEndpoint, { action, principalArn: OTHER, sourceVpce: 'vpce-0other' })).toBe(true);
      expect(denied(withEndpoint, { action })).toBe(true);
      expect(denied(withoutEndpoint, { action, principalArn: OTHER, sourceVpce: 'vpce-0data' })).toBe(true);
    }
    expect(denied(withEndpoint, { action: 's3:GetObject', principalArn: OTHER, sourceVpce: 'vpce-0data' })).toBe(false);
  });

  it('lets the dispatcher write, read, and delete from outside the endpoint, and nobody else write or delete', () => {
    expect(FUNCTION_DATA_DISPATCHER_ACTIONS).toEqual(['s3:PutObject', 's3:GetObject', 's3:DeleteObject']);
    for (const policy of [withEndpoint, withoutEndpoint]) {
      for (const action of FUNCTION_DATA_DISPATCHER_ACTIONS) {
        expect(denied(policy, { action, principalArn: DISPATCHER })).toBe(false);
      }
      for (const action of ['s3:PutObject', 's3:DeleteObject', 's3:DeleteObjectVersion', 's3:PutObjectAcl']) {
        expect(denied(policy, { action, principalArn: OTHER, sourceVpce: 'vpce-0data' })).toBe(true);
      }
    }
  });

  it('refuses every request without TLS, the dispatcher included', () => {
    expect(denied(withEndpoint, { action: 's3:GetObject', principalArn: DISPATCHER, secure: false })).toBe(true);
    expect(denied(withEndpoint, { action: 's3:PutBucketPolicy', principalArn: OTHER, secure: false })).toBe(true);
  });

  it('allows nothing and leaves the bucket settings to the deployer', () => {
    expect(withEndpoint.Statement.every(statement => statement.Effect === 'Deny')).toBe(true);
    expect(denied(withEndpoint, { action: 's3:GetBucketPolicy', principalArn: OTHER })).toBe(false);
    expect(denied(withEndpoint, { action: 's3:PutBucketPolicy', principalArn: OTHER })).toBe(false);
  });
});
