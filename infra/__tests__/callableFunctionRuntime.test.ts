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
import { callableFunctionRolePolicy } from '../callableFunctionNetwork';
import {
  CALLABLE_FUNCTION_LAMBDA_EPHEMERAL_STORAGE_MB,
  CALLABLE_FUNCTION_LAMBDA_MEMORY_MB,
  CALLABLE_FUNCTION_LAMBDA_RESERVED_CONCURRENCY,
  CALLABLE_FUNCTION_LAMBDA_TIMEOUT_SECONDS,
} from '../../packages/server-utils/src/callableFunctions/runtimeLimits';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

const source = stripComments(read('infra/callableFunctionRuntime.ts'));

/** The argument object of the sole `new <ctor>('<name>', { ... })`. */
function declaration(ctor: string, name: string): string {
  const anchor = new RegExp(`new ${ctor.replace(/\./g, '\\.')}\\(\\s*'${name}',\\s*`, 'g');
  const matches = [...source.matchAll(anchor)];
  expect(matches, `new ${ctor}('${name}', ...) must be declared once`).toHaveLength(1);
  return balanced(source, matches[0].index! + matches[0][0].length, '{', '}');
}

/** The body of the sole `function <name>(...)`. */
function functionBody(name: string): string {
  const at = source.indexOf(`function ${name}(`);
  expect(at, `function ${name} not found`).toBeGreaterThan(-1);
  expect(source.indexOf(`function ${name}(`, at + 1), `function ${name} declared twice`).toBe(-1);
  return balanced(source, at, '{', '}');
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

  it('gives its role one inline policy, no managed policy, and no log action on every resource', () => {
    expect(source).not.toMatch(/PolicyAttachment|managedPolicyArns|inlinePolicies|iam::aws:policy|aws\.iam\.Policy\(/);
    expect(source.match(/new aws\.iam\.RolePolicy\(/g)).toHaveLength(1);
    const rolePolicy = declaration('aws.iam.RolePolicy', 'CallableFunctionRuntimePolicy');
    expect(rolePolicy).toMatch(/role:\s*role\.name,/);
    expect(rolePolicy).toMatch(
      /policy:\s*logGroup\.arn\.apply\(arn => JSON\.stringify\(callableFunctionRolePolicy\(arn\)\)\)/
    );
    expect(fn).toMatch(/role:\s*role\.arn/);
    expect(source).toMatch(/\{\s*dependsOn:\s*\[rolePolicy\]\s*\}/);
    for (const statement of callableFunctionRolePolicy('runtime-log-group').Statement) {
      if (statement.Resource === '*') expect(statement.Action.filter(action => action.startsWith('logs:'))).toEqual([]);
    }
  });

  it('runs in a security group with no ingress and no egress rules, in the network it runs in', () => {
    const group = declaration('aws.ec2.SecurityGroup', 'CallableFunctionRuntimeSecurityGroup');
    expect(group).toMatch(/ingress:\s*\[\]/);
    expect(group).toMatch(/egress:\s*\[\]/);
    expect(group).toMatch(/vpcId:\s*network\.vpcId,/);
    expect(source).not.toMatch(/SecurityGroupRule|SecurityGroupIngressRule|SecurityGroupEgressRule/);
    expect(fn).toMatch(/securityGroupIds:\s*\[securityGroup\.id\]/);
  });

  it('runs on its own network: the named subnets, or a dedicated VPC', () => {
    expect(source).toMatch(
      /const network = namedSubnetIds\.length > 0 \? namedNetwork\(namedSubnetIds\) : dedicatedNetwork\(\);/
    );
    expect(fn).toMatch(/subnetIds:\s*network\.subnetIds,/);
    expect(source).not.toMatch(
      /from '\.\/vpc'|VPC_ID|\b(lambdaVpc|resolvedVpcId|privateRouteTables|gatewayEndpoints)\b/
    );
    expect(source).not.toMatch(/sst\.aws\.Vpc/);
  });

  it('builds the dedicated VPC with no name resolution, no IPv6, and no gateway', () => {
    const vpc = declaration('aws.ec2.Vpc', 'CallableFunctionRuntimeVpc');
    expect(vpc).toMatch(/enableDnsSupport:\s*false,/);
    expect(vpc).toMatch(/enableDnsHostnames:\s*false,/);
    expect(vpc).toMatch(/assignGeneratedIpv6CidrBlock:\s*false,/);
    expect(vpc).not.toMatch(/ipv6CidrBlock|ipv6IpamPoolId|ipv6NetmaskLength/);
    expect(source).not.toMatch(
      /new aws\.ec2\.(Route|VpcEndpoint|NatGateway|InternetGateway|EgressOnlyInternetGateway|VpcPeeringConnection|VpnGateway|VpnGatewayRoutePropagation|TransitGatewayVpcAttachment|VpcDhcpOptions\w*|VpcIpv6CidrBlockAssociation|MainRouteTableAssociation)\(/
    );
    expect(source).not.toMatch(/aws\.ec2transitgateway|aws\.route53/);

    const subnet = declaration('aws.ec2.Subnet', 'CallableFunctionRuntimeSubnet');
    expect(subnet).toMatch(/vpcId:\s*vpc\.id,/);
    expect(subnet).toMatch(/mapPublicIpOnLaunch:\s*false/);
    expect(subnet).not.toMatch(/ipv6|assignIpv6/i);
    const routeTable = declaration('aws.ec2.RouteTable', 'CallableFunctionRuntimeRouteTable');
    expect(routeTable).toMatch(/vpcId:\s*vpc\.id,/);
    expect(routeTable).toMatch(/routes:\s*\[\]/);
    const association = declaration('aws.ec2.RouteTableAssociation', 'CallableFunctionRuntimeRouteTableAssociation');
    expect(association).toMatch(/subnetId:\s*subnet\.id,/);
    expect(association).toMatch(/routeTableId:\s*routeTable\.id,/);
    expect(functionBody('dedicatedNetwork')).toMatch(
      /return \{ vpcId: vpc\.id, subnetIds: \$output\(\[subnet\.id\]\) \};/
    );
  });

  it('fails the deploy unless every named subnet passes subnetNetworkFaults', () => {
    const named = functionBody('namedNetwork');
    expect(named).toMatch(
      /const checked = \$resolve\(subnets\)\.apply\(read => \{\s*const faults = subnetNetworkFaults\(read\);\s*if \(faults\.length > 0\) throw new Error\(`CALLABLE_FUNCTION_SUBNET_IDS: \$\{faults\.join\('; '\)\}\.`\);\s*return read;\s*\}\);/
    );
    expect(named).toMatch(
      /return \{\s*vpcId: checked\.apply\(read => read\[0\]\.vpcId!\),\s*subnetIds: checked\.apply\(read => read\.map\(subnet => subnet\.subnetId\)\),\s*\};\s*\}$/
    );
    expect(named.match(/\breturn\b/g)).toHaveLength(3);
    // The table each subnet uses: its explicit association, else the VPC's main table.
    expect(named).toMatch(/name: 'association\.subnet-id', values: \[subnetId\]/);
    expect(named).toMatch(/vpcId, filters: \[\{ name: 'association\.main', values: \['true'\] \}\]/);
    expect(named).toMatch(/ids\[0\] \?\? mainIds\[0\]/);
    expect(named).toMatch(/enableDnsSupport: aws\.ec2\.getVpcOutput\(\{ id: vpcId \}\)\.enableDnsSupport,/);
    expect(named).toMatch(/routes: routeTableId\.apply\(routesOf\),/);

    const routes = functionBody('routesOf');
    expect(routes).toMatch(/has\('route\.gateway-id', \['local'\]\)/);
    expect(routes).toMatch(/has\('route\.gateway-id', \['vpce-\*'\]\)/);
    expect(routes).toMatch(/has\('route\.origin', \['EnableVgwRoutePropagation'\]\)/);
    expect(routes).toMatch(/\.\.\.routes,/);
  });

  it('creates the dedicated VPC only on the stages the repository treats as long-lived', () => {
    expect(source).toMatch(/const longLivedStage = PRODUCTION_STAGES\.includes\(\$app\.stage\);/);
    expect(source).toMatch(/import \{[^}]*\bPRODUCTION_STAGES\b[^}]*\} from '\.\/constants';/);
    expect(source.match(/\bdedicatedNetwork\(\)/g)).toHaveLength(2);
    expect(source).not.toMatch(/\bisPreviewStage\b/);
  });

  it('creates nothing on another stage without named subnets, and says so on every deploy', () => {
    expect(source).toMatch(/const skippedWithoutNetwork = !longLivedStage && namedSubnetIds\.length === 0;/);
    expect(source).toMatch(
      /if \(skippedWithoutNetwork\) \{\s*console\.warn\(\s*'[^']*only production and dev[^']*'\s*\);/
    );
    expect(source).not.toMatch(/preview/i);
    expect(source).toMatch(/const enabled = !\$dev && !!runtimeImage && !skippedWithoutNetwork;/);
  });

  it('reserves concurrency only on the long-lived stages', () => {
    expect(fn).toMatch(
      /reservedConcurrentExecutions:\s*longLivedStage \? CALLABLE_FUNCTION_LAMBDA_RESERVED_CONCURRENCY : undefined,/
    );
  });

  it('times out at the exported constant, never above 900 s, and sizes memory and storage from constants', () => {
    expect(fn).toMatch(/timeout:\s*CALLABLE_FUNCTION_LAMBDA_TIMEOUT_SECONDS,/);
    expect(fn).toMatch(/memorySize:\s*CALLABLE_FUNCTION_LAMBDA_MEMORY_MB,/);
    expect(fn).toMatch(/ephemeralStorage:\s*\{\s*size:\s*CALLABLE_FUNCTION_LAMBDA_EPHEMERAL_STORAGE_MB\s*\}/);
    expect(CALLABLE_FUNCTION_LAMBDA_TIMEOUT_SECONDS).toBeLessThanOrEqual(900);
    expect(CALLABLE_FUNCTION_LAMBDA_MEMORY_MB).toBeLessThanOrEqual(10_240);
    expect(CALLABLE_FUNCTION_LAMBDA_EPHEMERAL_STORAGE_MB).toBeLessThanOrEqual(10_240);
  });

  it('caps its concurrency at the exported constant', () => {
    expect(CALLABLE_FUNCTION_LAMBDA_RESERVED_CONCURRENCY).toBe(50);
  });

  it('turns on per-tenant isolation', () => {
    expect(fn).toMatch(/tenancyConfig:\s*\{\s*tenantIsolationMode:\s*'PER_TENANT'\s*\}/);
  });

  it('is skipped when the image is unset, exports its subnets, and the deploy contract builds the image', () => {
    expect(source).toMatch(/const runtime = enabled \? createCallableFunctionRuntime\(\) : undefined;/);
    expect(source).toMatch(/export const callableFunctionRuntime = runtime\?\.fn;/);
    expect(source).toMatch(
      /export const callableFunctionSubnetIds = runtime\?\.subnetIds\.apply\(ids => ids\.join\(','\)\);/
    );
    const config = stripComments(read('sst.config.ts'));
    expect(config).toMatch(/\bcallableFunctionSubnetIds,\s*\} = await import\('\.\/infra'\);/);
    expect(balanced(config, config.lastIndexOf('return {'), '{', '}')).toMatch(/\bcallableFunctionSubnetIds,/);
    const contract = JSON.parse(read('infra/deploy-contract.json')) as { builtImages: Array<Record<string, string>> };
    expect(contract.builtImages).toContainEqual({
      name: 'callable-function-runtime',
      dockerfile: 'apps/workers/Dockerfile.callablefunction',
      env: 'CALLABLE_FUNCTION_RUNTIME_IMAGE',
    });
    expect(stripComments(read('infra/index.ts'))).toMatch(/export \* from '\.\/callableFunctionRuntime';/);
  });

  it('alarms at Medium on errors, duration, and throttles, and needs 5 errors in a period', () => {
    for (const [name, metric] of [
      ['CallableFunctionRuntimeErrors', 'Errors'],
      ['CallableFunctionRuntimeDuration', 'Duration'],
      ['CallableFunctionRuntimeThrottles', 'Throttles'],
    ]) {
      const alarm = declaration('aws.cloudwatch.MetricAlarm', name);
      expect(alarm).toMatch(new RegExp(`metricName:\\s*'${metric}'`));
      expect(alarm).toMatch(/Severity: 'Medium'/);
    }
    const errors = declaration('aws.cloudwatch.MetricAlarm', 'CallableFunctionRuntimeErrors');
    expect(errors).toMatch(/statistic:\s*'Sum',/);
    expect(errors).toMatch(/threshold:\s*5,/);
    expect(errors).toMatch(/comparisonOperator:\s*'GreaterThanOrEqualToThreshold',/);
    expect(source).toMatch(/period:\s*300,/);
    expect(source).toMatch(/evaluationPeriods:\s*1,/);
    expect(source).toMatch(/dimensions:\s*\{\s*FunctionName:\s*fn\.name\s*\}/);
  });
});
