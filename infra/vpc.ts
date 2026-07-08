import { isPreviewStage } from './constants';

// The VPC is selected via the VPC_ID env var:
//  - Our envs set it automatically — CI from tenant config, local dev from
//    `./for-env <env> …` — so all non-prod stages share one VPC (single NAT
//    Gateway + EIP instead of a fresh VPC per stage).
//  - Left unset (e.g. an open-core self-hoster deploying to their own AWS),
//    a fresh VPC + NAT is provisioned below.
export const vpcId = process.env.VPC_ID;

// Cloud Map service discovery for preview stages (see chatCompletion.ts). Previews drop the
// per-preview ALB and reach the ChatCompletion service over a shared Cloud Map namespace,
// which avoids the ALB-to-security-group teardown chain that breaks preview cleanup. The
// namespace is provisioned in the previews VPC and passed in by the deployer via these env
// vars. Unset on prod/dev and self-host, so the ALB path is kept unchanged there.
const cloudmapNamespaceId = process.env.CLOUDMAP_NAMESPACE_ID;
const cloudmapNamespaceName = process.env.CLOUDMAP_NAMESPACE_NAME;
// Single source of truth for the Cloud Map path, consumed by chatCompletion.ts too.
// Both-or-neither: the namespace env must be present, else we keep the ALB (fail-safe rather
// than half-configuring the cluster). Only previews ever set it.
export const useCloudmap = isPreviewStage && !!cloudmapNamespaceId && !!cloudmapNamespaceName;

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
      // Preview only: register services in the shared Cloud Map namespace so they can be
      // reached by DNS without a per-preview ALB. Omitted on prod/dev, so the cluster
      // provisions no namespace and the ALB path is unchanged there.
      ...(useCloudmap ? { cloudmapNamespaceId, cloudmapNamespaceName } : {}),
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
