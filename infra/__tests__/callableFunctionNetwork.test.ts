/**
 * @vitest-environment node
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  callableFunctionDataBrowserReaderPolicy,
  callableFunctionDataBrowserReaderTrustPolicy,
  callableFunctionDataBucketPolicy,
  callableFunctionDataEndpointPolicy,
  callableFunctionRolePolicy,
  DEDICATED_SUBNET_CIDRS,
  distinctZones,
  FUNCTION_DATA_BROWSER_LINK_WINDOW_MS,
  FUNCTION_DATA_BROWSER_READER_ACTIONS,
  FUNCTION_DATA_DISPATCHER_ACTIONS,
  FUNCTION_DATA_ERASER_ACTIONS,
  FUNCTION_DATA_KEY_PREFIX,
  isGetObjectOnlyPolicy,
  LAMBDA_NETWORK_INTERFACE_ACTIONS,
  namedSubnetIdsOf,
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
  networkInterface: false,
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

  it('refuses a network interface route the data source omits', () => {
    expect(faultsOf([], { local: true, networkInterface: true })).toEqual([
      'subnet subnet-0a: route table rtb-0a has a route to a network interface',
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
    ['networkInterface', { name: 'route.network-interface-id', values: ['eni-*'] }],
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

  it("does not count the endpoint's own route as a route added to the table when it reads back as CreateRoute", () => {
    const routes = tableRoutes([], probes({ local: true, endpoint: true, created: true }), 'rtb-0a', ENDPOINT);
    expect(routes).toEqual([LOCAL, DATA_ROUTE]);
    expect(faultsWith(routes)).toEqual([]);
  });

  it('still counts a route added to a table the named endpoint does not list, or with no endpoint route', () => {
    const elsewhere = tableRoutes([], probes({ local: true, endpoint: true, created: true }), 'rtb-0b', ENDPOINT);
    expect(elsewhere).toContainEqual({ origin: 'CreateRoute' });
    const noEndpointRoute = tableRoutes([], probes({ local: true, created: true }), 'rtb-0a', ENDPOINT);
    expect(faultsWith(noEndpointRoute)).toEqual([
      'subnet subnet-0a: route table rtb-0a has a route to a route added to the table',
    ]);
  });

  it('still refuses a network interface route next to the accepted endpoint route', () => {
    const found = { local: true, endpoint: true, created: true, networkInterface: true };
    expect(faultsWith(tableRoutes([], probes(found), 'rtb-0a', ENDPOINT))).toEqual([
      'subnet subnet-0a: route table rtb-0a has a route to a network interface',
    ]);
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
      "endpoint vpce-0data has a policy that allows more than s3:GetObject on one bucket's data objects",
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
  const statement = { Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: `${BUCKET_ARN}/data/*` };
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
    ['every object in the bucket', policy({ ...statement, Resource: `${BUCKET_ARN}/*` })],
    ['another key segment', policy({ ...statement, Resource: `${BUCKET_ARN}/outputs/*` })],
    ['the data prefix without its slash', policy({ ...statement, Resource: `${BUCKET_ARN}/data*` })],
    ['two buckets', policy({ ...statement, Resource: [`${BUCKET_ARN}/data/*`, `${BUCKET_ARN}-other/data/*`] })],
    ['a NotAction', policy({ Effect: 'Allow', Principal: '*', NotAction: 's3:PutObject', Resource: '*' })],
    ['a Deny', policy({ ...statement, Effect: 'Deny' })],
    ['a Condition', policy({ ...statement, Condition: { StringEquals: { 'aws:SourceVpc': 'vpc-0a' } } })],
    ['a NotResource beside the Resource', policy({ ...statement, NotResource: `${BUCKET_ARN}/data/x` })],
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
  it("allows GetObject on the bucket's data/ objects and nothing else", () => {
    expect(callableFunctionDataEndpointPolicy(BUCKET_ARN)).toEqual({
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'FunctionDataReads',
          Effect: 'Allow',
          Principal: '*',
          Action: 's3:GetObject',
          Resource: `${BUCKET_ARN}/data/*`,
        },
      ],
    });
    expect(FUNCTION_DATA_KEY_PREFIX).toBe('data/');
  });
});

describe('the browser-link reader role', () => {
  it("may only read the data bucket's data/ objects", () => {
    expect(FUNCTION_DATA_BROWSER_READER_ACTIONS).toEqual(['s3:GetObject']);
    expect(callableFunctionDataBrowserReaderPolicy(BUCKET_ARN)).toEqual({
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'FunctionDataBrowserReads',
          Effect: 'Allow',
          Action: ['s3:GetObject'],
          Resource: `${BUCKET_ARN}/data/*`,
        },
      ],
    });
  });

  it("is trusted by the web API function's role alone", () => {
    expect(callableFunctionDataBrowserReaderTrustPolicy('web-server-role-arn')).toEqual({
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'WebApiFunctionOnly',
          Effect: 'Allow',
          Principal: { AWS: 'web-server-role-arn' },
          Action: 'sts:AssumeRole',
        },
      ],
    });
  });
});

describe('callableFunctionDataBucketPolicy', () => {
  const DISPATCHER = 'dispatcher-role-arn';
  const READER = 'browser-reader-role-arn';
  const OTHER = 'other-role-arn';

  const OBJECT = `${BUCKET_ARN}/data/t1/${'a'.repeat(64)}`;

  interface Request {
    action: string;
    /** The object or bucket ARN the request names. */
    resource: string;
    principalArn?: string;
    sourceVpce?: string;
    secure?: boolean;
    /** `REST-QUERY-STRING` for a signed link; a request signed in its header otherwise. */
    authType?: string;
    /** Milliseconds since the request or link was signed; past the browser window unless given. */
    signatureAge?: number;
  }

  const wildcard = (patterns: string | string[], value: string) =>
    [patterns]
      .flat()
      .some(pattern => new RegExp(`^${pattern.replace(/[.]/g, '\\.').replace(/\*/g, '.*')}$`).test(value));

  // Each condition key compares one value; a missing key fails the equality and passes the negated test.
  // A negated test over several values holds when the key matches none of them.
  const conditionHolds = (condition: Record<string, Record<string, string | string[]>> | undefined, request: Request) =>
    Object.entries(condition ?? {}).every(([test, pair]) =>
      Object.entries(pair).every(([key, value]) => {
        const actual = {
          'aws:PrincipalArn': request.principalArn,
          'aws:SourceVpce': request.sourceVpce,
          'aws:SecureTransport': String(request.secure ?? true),
          's3:authType': request.authType ?? 'REST-HEADER',
          's3:signatureAge': String(request.signatureAge ?? FUNCTION_DATA_BROWSER_LINK_WINDOW_MS + 1),
        }[key];
        const values = [value].flat();
        if (['Bool', 'StringEquals', 'ArnEquals'].includes(test)) return values.some(one => actual === one);
        if (test === 'NumericGreaterThan') return values.some(one => Number(actual) > Number(one));
        if (test === 'ArnNotEquals' || test === 'StringNotEquals') return values.every(one => actual !== one);
        throw new Error(`untested condition ${test}`);
      })
    );

  const denied = (policy: ReturnType<typeof callableFunctionDataBucketPolicy>, request: Request) =>
    policy.Statement.some(
      statement =>
        statement.Effect === 'Deny' &&
        wildcard(statement.Action, request.action) &&
        wildcard(statement.Resource, request.resource) &&
        conditionHolds(statement.Condition as Record<string, Record<string, string | string[]>>, request)
    );

  const withEndpoint = callableFunctionDataBucketPolicy({
    bucketArn: BUCKET_ARN,
    dispatcherRoleArn: DISPATCHER,
    browserReaderRoleArn: READER,
    endpointId: 'vpce-0data',
  });
  const withoutEndpoint = callableFunctionDataBucketPolicy({
    bucketArn: BUCKET_ARN,
    dispatcherRoleArn: DISPATCHER,
    browserReaderRoleArn: READER,
  });

  const readsOn = (action: string) => (action.startsWith('s3:ListBucket') ? BUCKET_ARN : OBJECT);

  it('refuses every read by any principal but the dispatcher, wherever it comes from', () => {
    for (const policy of [withEndpoint, withoutEndpoint]) {
      for (const action of ['s3:GetObject', 's3:GetObjectVersion', 's3:GetObjectAttributes', 's3:ListBucket']) {
        const resource = readsOn(action);
        for (const sourceVpce of [undefined, 'vpce-0other', 'vpce-0data']) {
          expect(denied(policy, { action, resource, principalArn: OTHER, sourceVpce })).toBe(true);
          expect(denied(policy, { action, resource, sourceVpce })).toBe(true);
        }
      }
    }
  });

  it("refuses the runtime's role a read through the endpoint and allows only the dispatcher's links there", () => {
    const read = { action: 's3:GetObject', resource: `${BUCKET_ARN}/data/x` };
    expect(denied(withEndpoint, { ...read, principalArn: 'runtime-role-arn', sourceVpce: 'vpce-0data' })).toBe(true);
    const link = { ...read, principalArn: DISPATCHER, authType: 'REST-QUERY-STRING' };
    expect(denied(withEndpoint, { ...link, sourceVpce: 'vpce-0data' })).toBe(false);
    expect(denied(withEndpoint, link)).toBe(true);
  });

  it('refuses reads, writes, and deletes by other principals outside the data/ segment too', () => {
    const resource = `${BUCKET_ARN}/outputs/t1/x`;
    for (const action of ['s3:GetObject', 's3:PutObject', 's3:DeleteObject']) {
      for (const sourceVpce of [undefined, 'vpce-0data']) {
        expect(denied(withEndpoint, { action, resource, principalArn: OTHER, sourceVpce })).toBe(true);
      }
    }
  });

  it('refuses a read by a signed link from outside the endpoint for every principal, the dispatcher included', () => {
    const link = { action: 's3:GetObject', resource: OBJECT, authType: 'REST-QUERY-STRING' };
    for (const principalArn of [DISPATCHER, OTHER, undefined]) {
      expect(denied(withEndpoint, { ...link, principalArn })).toBe(true);
      expect(denied(withEndpoint, { ...link, principalArn, sourceVpce: 'vpce-0other' })).toBe(true);
      expect(denied(withoutEndpoint, { ...link, principalArn, sourceVpce: 'vpce-0data' })).toBe(true);
    }
    expect(denied(withEndpoint, { ...link, action: 's3:GetObjectVersion', principalArn: DISPATCHER })).toBe(true);
    expect(denied(withEndpoint, { ...link, principalArn: DISPATCHER, sourceVpce: 'vpce-0data' })).toBe(false);
  });

  const AGES = [0, 1, FUNCTION_DATA_BROWSER_LINK_WINDOW_MS, FUNCTION_DATA_BROWSER_LINK_WINDOW_MS + 1, 3_600_000];

  it("refuses the dispatcher's signed link from outside the endpoint at any age, a fresh one included", () => {
    const link = { action: 's3:GetObject', resource: OBJECT, authType: 'REST-QUERY-STRING' };
    for (const signatureAge of AGES) {
      for (const principalArn of [DISPATCHER, OTHER, undefined]) {
        for (const sourceVpce of [undefined, 'vpce-0other']) {
          expect(denied(withEndpoint, { ...link, principalArn, sourceVpce, signatureAge })).toBe(true);
          expect(denied(withoutEndpoint, { ...link, principalArn, sourceVpce, signatureAge })).toBe(true);
        }
      }
      expect(denied(withEndpoint, { ...link, principalArn: DISPATCHER, sourceVpce: 'vpce-0data', signatureAge })).toBe(
        false
      );
    }
  });

  it("allows the browser reader's signed link from anywhere for its first minute and refuses it after", () => {
    const link = { action: 's3:GetObject', resource: OBJECT, authType: 'REST-QUERY-STRING', principalArn: READER };
    for (const policy of [withEndpoint, withoutEndpoint]) {
      for (const sourceVpce of [undefined, 'vpce-0other', 'vpce-0data']) {
        expect(denied(policy, { ...link, sourceVpce, signatureAge: 1 })).toBe(false);
        expect(denied(policy, { ...link, sourceVpce, signatureAge: FUNCTION_DATA_BROWSER_LINK_WINDOW_MS })).toBe(false);
        expect(denied(policy, { ...link, sourceVpce, signatureAge: FUNCTION_DATA_BROWSER_LINK_WINDOW_MS + 1 })).toBe(
          true
        );
        expect(denied(policy, { ...link, action: 's3:GetObjectVersion', sourceVpce, signatureAge: 3_600_000 })).toBe(
          true
        );
      }
    }
    expect(FUNCTION_DATA_BROWSER_LINK_WINDOW_MS).toBe(60_000);
  });

  it('refuses the browser reader every write, list, and delete, wherever it comes from and however it signs', () => {
    const actions = [
      's3:PutObject',
      's3:PutObjectAcl',
      's3:ReplicateObject',
      's3:DeleteObject',
      's3:DeleteObjectVersion',
      's3:ListBucket',
      's3:ListBucketVersions',
    ];
    for (const policy of [withEndpoint, withoutEndpoint]) {
      for (const action of actions) {
        for (const authType of ['REST-HEADER', 'REST-QUERY-STRING']) {
          for (const sourceVpce of [undefined, 'vpce-0data']) {
            const request = { action, resource: readsOn(action), principalArn: READER, authType, sourceVpce };
            expect(denied(policy, { ...request, signatureAge: 1 })).toBe(true);
          }
        }
      }
    }
  });

  it('keeps header-signed reads, writes, and deletes by the dispatcher from outside the endpoint', () => {
    for (const policy of [withEndpoint, withoutEndpoint]) {
      for (const action of FUNCTION_DATA_DISPATCHER_ACTIONS) {
        expect(denied(policy, { action, resource: OBJECT, principalArn: DISPATCHER, authType: 'REST-HEADER' })).toBe(
          false
        );
      }
    }
  });

  it('lets nobody but the dispatcher write, delete, or replicate objects, wherever the request comes from', () => {
    expect(FUNCTION_DATA_DISPATCHER_ACTIONS).toEqual(['s3:PutObject', 's3:GetObject', 's3:DeleteObject']);
    const writes = ['s3:PutObject', 's3:DeleteObject', 's3:DeleteObjectVersion', 's3:PutObjectAcl'];
    for (const policy of [withEndpoint, withoutEndpoint]) {
      for (const action of [...writes, 's3:ReplicateObject', 's3:ReplicateDelete']) {
        expect(denied(policy, { action, resource: OBJECT, principalArn: OTHER, sourceVpce: 'vpce-0data' })).toBe(true);
        expect(denied(policy, { action, resource: OBJECT, principalArn: OTHER })).toBe(true);
      }
    }
  });

  it("exempts the account-erasure worker's and the deletion sweep's roles from the list and delete refusals only, and no one else", () => {
    const ERASER = 'eraser-role-arn';
    const SWEEP = 'deletion-sweep-role-arn';
    const withEraser = callableFunctionDataBucketPolicy({
      bucketArn: BUCKET_ARN,
      dispatcherRoleArn: DISPATCHER,
      browserReaderRoleArn: READER,
      eraserRoleArns: [ERASER, SWEEP],
      endpointId: 'vpce-0data',
    });
    expect(FUNCTION_DATA_ERASER_ACTIONS).toEqual(['s3:DeleteObject']);
    for (const principalArn of [DISPATCHER, ERASER, SWEEP]) {
      expect(denied(withEraser, { action: 's3:DeleteObject', resource: OBJECT, principalArn })).toBe(false);
      expect(denied(withEraser, { action: 's3:ListBucket', resource: BUCKET_ARN, principalArn })).toBe(false);
    }
    expect(denied(withEraser, { action: 's3:DeleteObject', resource: OBJECT, principalArn: OTHER })).toBe(true);
    for (const principalArn of [ERASER, SWEEP]) {
      for (const action of [
        's3:GetObject',
        's3:GetObjectVersion',
        's3:PutObject',
        's3:PutObjectAcl',
        's3:ReplicateObject',
      ]) {
        expect(denied(withEraser, { action, resource: OBJECT, principalArn })).toBe(true);
      }
      expect(denied(withEndpoint, { action: 's3:DeleteObject', resource: OBJECT, principalArn })).toBe(true);
      const link = { action: 's3:GetObject', resource: OBJECT, authType: 'REST-QUERY-STRING', principalArn };
      expect(denied(withEraser, link)).toBe(true);
    }
  });

  it('exempts no eraser for an empty role name, as on a stage without the deletion sweep', () => {
    const noSweep = callableFunctionDataBucketPolicy({
      bucketArn: BUCKET_ARN,
      dispatcherRoleArn: DISPATCHER,
      browserReaderRoleArn: READER,
      eraserRoleArns: ['eraser-role-arn', ''],
      endpointId: 'vpce-0data',
    });
    expect(denied(noSweep, { action: 's3:DeleteObject', resource: OBJECT, principalArn: '' })).toBe(true);
    expect(JSON.stringify(noSweep)).not.toMatch(/""/);
  });

  it('refuses every request without TLS, the dispatcher included', () => {
    const insecure = { principalArn: DISPATCHER, secure: false };
    expect(denied(withEndpoint, { action: 's3:GetObject', resource: OBJECT, ...insecure })).toBe(true);
    expect(denied(withEndpoint, { action: 's3:PutBucketPolicy', resource: BUCKET_ARN, ...insecure })).toBe(true);
  });

  it('allows nothing and leaves the bucket settings to the deployer', () => {
    expect(withEndpoint.Statement.every(statement => statement.Effect === 'Deny')).toBe(true);
    expect(denied(withEndpoint, { action: 's3:GetBucketPolicy', resource: BUCKET_ARN, principalArn: OTHER })).toBe(
      false
    );
    expect(denied(withEndpoint, { action: 's3:PutBucketPolicy', resource: BUCKET_ARN, principalArn: OTHER })).toBe(
      false
    );
  });

  it('matches requests by resource, so a statement scoped to another resource does not apply', () => {
    const elsewhere = `arn:${PARTITION}:s3:::other-bucket/data/t1/${'a'.repeat(64)}`;
    expect(denied(withEndpoint, { action: 's3:PutObject', resource: elsewhere, principalArn: OTHER })).toBe(false);
    expect(denied(withEndpoint, { action: 's3:GetObject', resource: elsewhere, principalArn: OTHER })).toBe(false);
  });
});

describe('namedSubnetIdsOf', () => {
  it('reads a comma-separated list, trimming blanks', () => {
    expect(namedSubnetIdsOf(' subnet-0a , ,subnet-0b ')).toEqual(['subnet-0a', 'subnet-0b']);
    expect(namedSubnetIdsOf('')).toEqual([]);
    expect(namedSubnetIdsOf(undefined)).toEqual([]);
  });
});
