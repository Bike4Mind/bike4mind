/**
 * @vitest-environment node
 *
 * The callable function runtime runs untrusted Python, so it must hold nothing worth reaching and have no route out.
 * infra/ is an SST program and does not load outside `sst`, so this is a text match like remoteMcpIsolation.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { balanced, stripComments } from './helpers/infraSource';
import {
  CALLABLE_FUNCTION_LAMBDA_EPHEMERAL_STORAGE_MB,
  CALLABLE_FUNCTION_LAMBDA_MEMORY_MB,
  CALLABLE_FUNCTION_LAMBDA_TIMEOUT_SECONDS,
  CALLABLE_FUNCTION_LIMITS,
} from '../../packages/server-utils/src/callableFunctions/runtimeLimits';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

const source = stripComments(read('infra/callableFunctionRuntime.ts'));

/** The argument object of the sole `new <ctor>('<name>', { ... })`. */
function declaration(ctor: string, name: string): string {
  const anchor = `new ${ctor}('${name}', `;
  const at = source.indexOf(anchor);
  expect(at, `${anchor} not found`).toBeGreaterThan(-1);
  expect(source.indexOf(anchor, at + 1), `${anchor} declared twice`).toBe(-1);
  return balanced(source, at + anchor.length, '{', '}');
}

describe('callable function runtime isolation', () => {
  const fn = declaration('aws.lambda.Function', 'CallableFunctionRuntime');

  it('is one Lambda, from the prebuilt image', () => {
    expect(source.match(/new (aws\.lambda|sst\.aws)\.Function\(/g)).toHaveLength(1);
    expect(fn).toMatch(/packageType:\s*'Image'/);
    expect(fn).toMatch(/imageUri:\s*runtimeImage!/);
    expect(source).toMatch(/const runtimeImage = process\.env\.CALLABLE_FUNCTION_RUNTIME_IMAGE;/);
  });

  it('links nothing and holds no secrets, permissions, or environment', () => {
    expect(source).not.toMatch(/\blink\b/);
    expect(source).not.toMatch(/\bsecrets\b/);
    expect(source).not.toMatch(/\bpermissions\s*:/);
    expect(source).not.toMatch(/DEFAULT_LAMBDA_ENVIRONMENT/);
    expect(fn).not.toMatch(/\benvironment\s*:/);
  });

  it('grants its role only the managed VPC access policy', () => {
    expect(source).not.toMatch(/aws\.iam\.(RolePolicy|Policy)\(|inlinePolicies|managedPolicyArns/);
    expect(source.match(/new aws\.iam\.RolePolicyAttachment\(/g)).toHaveLength(1);
    expect(declaration('aws.iam.RolePolicyAttachment', 'CallableFunctionRuntimeVpcAccess')).toMatch(
      /policyArn:\s*\$interpolate`arn:\$\{partition\}:iam::aws:policy\/service-role\/AWSLambdaVPCAccessExecutionRole`/
    );
    expect(fn).toMatch(/role:\s*role\.arn/);
  });

  it('runs in a security group with no ingress and no egress rules', () => {
    const group = declaration('aws.ec2.SecurityGroup', 'CallableFunctionRuntimeSecurityGroup');
    expect(group).toMatch(/ingress:\s*\[\]/);
    expect(group).toMatch(/egress:\s*\[\]/);
    expect(source).not.toMatch(/SecurityGroupRule|SecurityGroupIngressRule|SecurityGroupEgressRule/);
    expect(fn).toMatch(/securityGroupIds:\s*\[securityGroup\.id\]/);
  });

  it('runs in subnets with no route out of the VPC', () => {
    expect(fn).toMatch(/subnetIds:\s*isolatedSubnetIds\(\)/);
    expect(declaration('aws.ec2.RouteTable', 'CallableFunctionRuntimeRouteTable')).toMatch(/routes:\s*\[\]/);
    expect(declaration('aws.ec2.Subnet', 'CallableFunctionRuntimeSubnet')).toMatch(/mapPublicIpOnLaunch:\s*false/);
    expect(source).not.toMatch(/new aws\.ec2\.(Route|VpcEndpoint|NatGateway|InternetGateway)\(/);
    expect(source).not.toMatch(/\b(lambdaVpc|privateRouteTables|gatewayEndpoints)\b/);
    // A shared VPC's subnets are refused at deploy when their route table has anything but the local route.
    expect(source).toMatch(/routes\.filter\(route => route\.gatewayId !== 'local'\)/);
    expect(source).toMatch(/if \(out\.length > 0\) \{\s*throw new Error\(/);
  });

  it('times out at the exported constant, never above 900 s, and sizes memory and storage from constants', () => {
    expect(fn).toMatch(/timeout:\s*CALLABLE_FUNCTION_LAMBDA_TIMEOUT_SECONDS,/);
    expect(fn).toMatch(/memorySize:\s*CALLABLE_FUNCTION_LAMBDA_MEMORY_MB,/);
    expect(fn).toMatch(/ephemeralStorage:\s*\{\s*size:\s*CALLABLE_FUNCTION_LAMBDA_EPHEMERAL_STORAGE_MB\s*\}/);
    expect(CALLABLE_FUNCTION_LAMBDA_TIMEOUT_SECONDS).toBeLessThanOrEqual(900);
    expect(CALLABLE_FUNCTION_LAMBDA_MEMORY_MB).toBeGreaterThan(CALLABLE_FUNCTION_LIMITS.memoryMb);
    expect(CALLABLE_FUNCTION_LAMBDA_MEMORY_MB).toBeLessThanOrEqual(10_240);
    expect(CALLABLE_FUNCTION_LAMBDA_EPHEMERAL_STORAGE_MB).toBeLessThanOrEqual(10_240);
  });

  it('turns on per-tenant isolation', () => {
    expect(fn).toMatch(/tenancyConfig:\s*\{\s*tenantIsolationMode:\s*'PER_TENANT'\s*\}/);
  });

  it('is skipped when the image is unset, and the deploy contract builds the image', () => {
    expect(source).toMatch(/const enabled = !\$dev && !!runtimeImage && /);
    expect(source).toMatch(
      /export const callableFunctionRuntime = enabled \? createCallableFunctionRuntime\(\) : undefined;/
    );
    const contract = JSON.parse(read('infra/deploy-contract.json')) as { builtImages: Array<Record<string, string>> };
    expect(contract.builtImages).toContainEqual({
      name: 'callable-function-runtime',
      dockerfile: 'apps/workers/Dockerfile.callablefunction',
      env: 'CALLABLE_FUNCTION_RUNTIME_IMAGE',
    });
    expect(stripComments(read('infra/index.ts'))).toMatch(/export \* from '\.\/callableFunctionRuntime';/);
  });

  it('alarms on errors, duration, and throttles', () => {
    for (const [name, metric] of [
      ['CallableFunctionRuntimeErrors', 'Errors'],
      ['CallableFunctionRuntimeDuration', 'Duration'],
      ['CallableFunctionRuntimeThrottles', 'Throttles'],
    ]) {
      expect(declaration('aws.cloudwatch.MetricAlarm', name)).toMatch(new RegExp(`metricName:\\s*'${metric}'`));
    }
    expect(source).toMatch(/dimensions:\s*\{\s*FunctionName:\s*fn\.name\s*\}/);
  });
});
