import { isPreviewStage } from './constants';

// The VPC is selected via the VPC_ID env var:
//  - Our envs set it automatically — CI from tenant config, local dev from
//    `./for-env <env> …` — so all non-prod stages share one VPC (single NAT
//    Gateway + EIP instead of a fresh VPC per stage).
//  - Left unset (e.g. an open-core self-hoster deploying to their own AWS),
//    a fresh VPC + NAT is provisioned below.
export const vpcId = process.env.VPC_ID;

// Create the VPC - either existing or new
export const vpc = vpcId
  ? undefined
  : new sst.aws.Vpc('VPC', {
      az: 1,
      nat: {
        type: 'ec2',
      },
    });

// Effective VPC id for consumers that need a concrete id (SG/subnet lookups):
// the env-provided id, or the freshly-provisioned VPC's id when VPC_ID is unset.
// Exactly one of vpcId / vpc is set, so this is always defined.
export const resolvedVpcId = vpcId ?? vpc!.id;

// Cluster VPC configuration
const clusterVpcConfig = vpcId
  ? {
      id: vpcId,
      securityGroups: aws.ec2.getSecurityGroupsOutput({
        filters: [
          { name: 'vpc-id', values: [vpcId] },
          { name: 'group-name', values: ['default'] },
        ],
      }).ids,
      serviceSubnets: aws.ec2.getSubnetsOutput({
        filters: [
          { name: 'vpc-id', values: [vpcId] },
          { name: 'tag:Name', values: ['*private*'] },
        ],
      }).ids,
      loadBalancerSubnets: aws.ec2.getSubnetsOutput({
        filters: [
          { name: 'vpc-id', values: [vpcId] },
          { name: 'tag:Name', values: ['*public*'] },
        ],
      }).ids,
    }
  : undefined;

// Lambda VPC configuration
const lambdaVpcConfig = vpcId
  ? {
      securityGroups: aws.ec2.getSecurityGroupsOutput({
        filters: [
          { name: 'vpc-id', values: [vpcId] },
          { name: 'group-name', values: ['default'] },
        ],
      }).ids,
      privateSubnets: aws.ec2.getSubnetsOutput({
        filters: [
          { name: 'vpc-id', values: [vpcId] },
          { name: 'tag:Name', values: ['*private*'] },
        ],
      }).ids,
    }
  : undefined;

// SST Cluster v2 requires explicit acknowledgment of breaking changes before deploying.
// Preview stages use forceUpgrade: 'v2' to confirm the upgrade to public-subnet placement.
// Non-preview stages (dev, production) are already acknowledged and need no flag.
export const cluster = new sst.aws.Cluster('Cluster', {
  vpc: vpc || clusterVpcConfig!,
  ...(isPreviewStage ? { forceUpgrade: 'v2' as const } : {}),
});

// Export VPC for Lambda functions
export const lambdaVpc = vpc || lambdaVpcConfig;
