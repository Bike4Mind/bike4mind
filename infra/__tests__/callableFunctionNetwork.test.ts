/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import {
  callableFunctionRolePolicy,
  LAMBDA_NETWORK_INTERFACE_ACTIONS,
  subnetNetworkFaults,
  type RouteTarget,
  type SubnetNetwork,
} from '../callableFunctionNetwork';

const LOCAL: RouteTarget = { gatewayId: 'local' };

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

  it.each<[string, RouteTarget, string]>([
    ['NAT gateway', { natGatewayId: 'nat-0a' }, 'a NAT gateway'],
    ['internet gateway', { gatewayId: 'igw-0a' }, 'an internet gateway'],
    ['transit gateway', { transitGatewayId: 'tgw-0a' }, 'a transit gateway'],
    ['egress-only IPv6', { egressOnlyGatewayId: 'eigw-0a' }, 'an egress-only internet gateway'],
    ['peering', { vpcPeeringConnectionId: 'pcx-0a' }, 'a peering connection'],
    ['gateway endpoint', { gatewayId: 'vpce-0a', destinationPrefixListId: 'pl-0a' }, 'a gateway endpoint'],
    ['propagated', { origin: 'EnableVgwRoutePropagation' }, 'a virtual private gateway'],
    ['network interface', { networkInterfaceId: 'eni-0a' }, 'a network interface'],
    ['no target', {}, 'an unknown target'],
  ])('refuses a %s route by name', (_kind, route, name) => {
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

  it('grants no log action on every resource', () => {
    for (const statement of policy.Statement) {
      if (statement.Action.some(action => action.startsWith('logs:'))) expect(statement.Resource).not.toBe('*');
      if (statement.Resource === '*') expect(statement.Action.every(action => action.startsWith('ec2:'))).toBe(true);
    }
  });
});
