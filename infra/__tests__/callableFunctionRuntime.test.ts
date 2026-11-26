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
  CALLABLE_FUNCTION_LAMBDA_RESERVED_CONCURRENCY,
  CALLABLE_FUNCTION_LAMBDA_TIMEOUT_SECONDS,
} from '../../packages/server-utils/src/callableFunctions/runtimeLimits';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

const source = stripComments(read('infra/callableFunctionRuntime.ts'));

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The argument object of the sole `new <ctor>(<nameLiteral>, { ... })`. */
function declarationOf(ctor: string, nameLiteral: string): string {
  const anchor = new RegExp(`new ${escapeRegExp(ctor)}\\(\\s*${escapeRegExp(nameLiteral)},\\s*`, 'g');
  const matches = [...source.matchAll(anchor)];
  expect(matches, `new ${ctor}(${nameLiteral}, ...) must be declared once`).toHaveLength(1);
  return balanced(source, matches[0].index! + matches[0][0].length, '{', '}');
}

const declaration = (ctor: string, name: string) => declarationOf(ctor, `'${name}'`);

/** The body of the sole `function <name>(...)`. */
function functionBody(name: string, text = source): string {
  const at = text.indexOf(`function ${name}(`);
  expect(at, `function ${name} not found`).toBeGreaterThan(-1);
  expect(text.indexOf(`function ${name}(`, at + 1), `function ${name} declared twice`).toBe(-1);
  return balanced(text, at, '{', '}');
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

  it('gives its role one inline policy and no managed policy, and logs to its own log group', () => {
    expect(source).not.toMatch(/PolicyAttachment|managedPolicyArns|inlinePolicies|iam::aws:policy|aws\.iam\.Policy\(/);
    expect(source.match(/new aws\.iam\.RolePolicy\(/g)).toHaveLength(1);
    const rolePolicy = declaration('aws.iam.RolePolicy', 'CallableFunctionRuntimePolicy');
    expect(rolePolicy).toMatch(/role:\s*role\.name,/);
    expect(rolePolicy).toMatch(
      /policy:\s*logGroup\.arn\.apply\(arn => JSON\.stringify\(callableFunctionRolePolicy\(arn\)\)\)/
    );
    expect(fn).toMatch(/role:\s*role\.arn/);
    expect(source).toMatch(/\{\s*dependsOn:\s*\[rolePolicy\]\s*\}/);
    expect(fn).toMatch(/loggingConfig:\s*\{\s*logFormat:\s*'Text',\s*logGroup:\s*logGroup\.name\s*\}/);
  });

  it('runs in a security group with no ingress, and one egress rule to the data endpoint on its own network only', () => {
    const group = declaration('aws.ec2.SecurityGroup', 'CallableFunctionRuntimeSecurityGroup');
    expect(group).toMatch(/ingress:\s*\[\],/);
    expect(group).toMatch(
      /egress: dataEndpoint\s*\? \[\{ protocol: 'tcp', fromPort: 443, toPort: 443, prefixListIds: \[dataEndpoint\.prefixListId\] \}\]\s*: \[\],/
    );
    expect(group.match(/protocol:/g)).toHaveLength(1);
    expect(group).not.toMatch(/cidrBlocks|ipv6CidrBlocks|securityGroups|self:/);
    expect(functionBody('createCallableFunctionRuntime')).toMatch(/const \{ dataEndpoint \} = network;/);
    expect(functionBody('namedNetwork')).toMatch(/dataEndpoint: undefined,\s*\};\s*\}$/);
    expect(group).toMatch(/vpcId:\s*network\.vpcId,/);
    expect(source).not.toMatch(/SecurityGroupRule|SecurityGroupIngressRule|SecurityGroupEgressRule/);
    expect(fn).toMatch(/securityGroupIds:\s*\[securityGroup\.id\]/);
  });

  it('runs on its own network: the named subnets, or a dedicated VPC', () => {
    expect(source).toMatch(
      /const network = callableFunctionDataBucket\s*\? dedicatedNetwork\(callableFunctionDataBucket\)\s*: namedNetwork\(namedSubnetIds\);/
    );
    expect(source).toMatch(/const namedSubnetIds = namedSubnetIdsOf\(process\.env\.CALLABLE_FUNCTION_SUBNET_IDS\);/);
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
      /new aws\.ec2\.(Route|NatGateway|InternetGateway|EgressOnlyInternetGateway|VpcPeeringConnection|VpnGateway|VpnGatewayRoutePropagation|TransitGatewayVpcAttachment|VpcDhcpOptions\w*|VpcIpv6CidrBlockAssociation|MainRouteTableAssociation)\(/
    );
    expect(source).not.toMatch(/aws\.ec2transitgateway|aws\.route53/);

    const routeTable = declaration('aws.ec2.RouteTable', 'CallableFunctionRuntimeRouteTable');
    expect(routeTable).toMatch(/vpcId:\s*vpc\.id,/);
    expect(routeTable).toMatch(/routes:\s*\[\]/);
  });

  it('spreads the dedicated network over two subnets in two zones, on the one empty route table', () => {
    const body = functionBody('dedicatedNetwork');
    expect(source.match(/new aws\.ec2\.Subnet\(/g)).toHaveLength(1);
    expect(source.match(/new aws\.ec2\.RouteTableAssociation\(/g)).toHaveLength(1);
    expect(source.match(/new aws\.ec2\.RouteTable\(/g)).toHaveLength(1);
    expect(body).toMatch(/const subnets = DEDICATED_SUBNET_CIDRS\.map\(\s*\(cidrBlock, index\) =>/);
    const subnet = declarationOf('aws.ec2.Subnet', '`CallableFunctionRuntimeSubnet${index + 1}`');
    expect(subnet).toMatch(/vpcId:\s*vpc\.id,/);
    expect(subnet).toMatch(/cidrBlock,/);
    expect(subnet).toMatch(/availabilityZoneId:\s*zoneIds\.apply\(ids => ids\[index\]\),/);
    expect(subnet).toMatch(/mapPublicIpOnLaunch:\s*false/);
    expect(subnet).not.toMatch(/ipv6|assignIpv6/i);
    expect(body).toMatch(/\.zoneIds\.apply\(ids => distinctZones\(ids, DEDICATED_SUBNET_CIDRS\.length\)\)/);
    expect(body).toMatch(/subnets\.forEach\(/);
    const association = declarationOf(
      'aws.ec2.RouteTableAssociation',
      '`CallableFunctionRuntimeRouteTableAssociation${index + 1}`'
    );
    expect(association).toMatch(/subnetId:\s*subnet\.id,/);
    expect(association).toMatch(/routeTableId:\s*routeTable\.id,/);
    expect(body).toMatch(
      /return \{ vpcId: vpc\.id, subnetIds: \$output\(subnets\.map\(subnet => subnet\.id\)\), dataEndpoint \};/
    );
  });

  it('routes the dedicated network to S3 through one gateway endpoint whose policy allows only data reads', () => {
    expect(source.match(/new aws\.ec2\.VpcEndpoint\(/g)).toHaveLength(1);
    const endpoint = declaration('aws.ec2.VpcEndpoint', 'CallableFunctionRuntimeDataEndpoint');
    expect(functionBody('dedicatedNetwork')).toContain(endpoint);
    expect(endpoint).toMatch(/vpcId:\s*vpc\.id,/);
    expect(endpoint).toMatch(/serviceName:\s*S3_SERVICE_NAME,/);
    expect(endpoint).toMatch(/vpcEndpointType:\s*'Gateway',/);
    expect(endpoint).toMatch(/routeTableIds:\s*\[routeTable\.id\],/);
    expect(endpoint).toMatch(
      /policy:\s*dataBucket\.arn\.apply\(arn => JSON\.stringify\(callableFunctionDataEndpointPolicy\(arn\)\)\),/
    );
    expect(source).toMatch(/function dedicatedNetwork\(dataBucket: aws\.s3\.Bucket\) \{/);
    expect(endpoint).not.toMatch(/privateDnsEnabled|subnetIds|securityGroupIds/);
    expect(source).toMatch(
      /const S3_SERVICE_NAME = \$interpolate`com\.amazonaws\.\$\{aws\.getRegionOutput\(\)\.region\}\.s3`;/
    );
  });

  it('gives the runtime role no S3 permission and the function no data bucket', () => {
    expect(source).not.toMatch(/['"`]s3:/);
    expect(fn).not.toMatch(/callableFunctionData|dataBucket|dataEndpoint/);
    const rolePolicy = declaration('aws.iam.RolePolicy', 'CallableFunctionRuntimePolicy');
    expect(rolePolicy).not.toMatch(/callableFunctionData|bucket/i);
  });

  it('fails the deploy unless every named subnet passes subnetNetworkFaults', () => {
    const named = functionBody('namedNetwork');
    expect(named).toMatch(
      /const lookups = \$util\.all\(\[\$resolve\(subnets\), dataEndpoint, S3_SERVICE_NAME, aws\.getPartitionOutput\(\)\.partition\]\);\s*const checked = lookups\.apply\(\(\[network, endpoint, s3ServiceName, partition\]\) => \{\s*const faults = subnetNetworkFaults\(network, endpoint && \{ endpoint, s3ServiceName, partition \}\);\s*if \(faults\.length > 0\) throw new Error\(`CALLABLE_FUNCTION_SUBNET_IDS: \$\{faults\.join\('; '\)\}\.`\);\s*return network;\s*\}\);/
    );
    expect(named).toMatch(
      /return \{\s*vpcId: checked\.apply\(read => read\[0\]\.vpcId!\),\s*subnetIds: checked\.apply\(read => read\.map\(subnet => subnet\.subnetId\)\),\s*dataEndpoint: undefined,\s*\};\s*\}$/
    );
    expect(named).toMatch(
      /const dataEndpoint = \$output\(namedDataEndpointId \? dataEndpointOf\(namedDataEndpointId\) : undefined\);/
    );
    expect(named).toMatch(/const prefixListIds = aws\.ec2\.getManagedPrefixListsOutput\(\{\}\)\.ids;/);
    expect(source).toMatch(
      /const namedDataEndpointId = process\.env\.CALLABLE_FUNCTION_DATA_ENDPOINT_ID\?\.trim\(\) \|\| undefined;/
    );
    const endpointRead = functionBody('dataEndpointOf');
    expect(endpointRead).toMatch(/aws\.ec2\.getVpcEndpointOutput\(\{ id \}\)/);
    const fields = ['vpcId', 'vpcEndpointType', 'serviceName', 'state', 'prefixListId', 'routeTableIds', 'policy'];
    for (const field of fields) expect(endpointRead).toMatch(new RegExp(`${field}: endpoint\\.${field},`));
    expect(named.match(/\breturn\b/g)).toHaveLength(3);
    // The table each subnet uses: its explicit association, else the VPC's main table.
    expect(named).toMatch(/name: 'association\.subnet-id', values: \[subnetId\]/);
    expect(named).toMatch(/vpcId, filters: \[\{ name: 'association\.main', values: \['true'\] \}\]/);
    expect(named).toMatch(/ids\[0\] \?\? mainIds\[0\]/);
    expect(named).toMatch(/enableDnsSupport: aws\.ec2\.getVpcOutput\(\{ id: vpcId \}\)\.enableDnsSupport,/);
    expect(named).toMatch(/routes: routeTableId\.apply\(id => routesOf\(id, dataEndpoint, prefixListIds\)\),/);

    const routes = functionBody('routesOf');
    expect(routes).toMatch(/routes: aws\.ec2\.getRouteTableOutput\(\{ routeTableId \}\)\.routes,/);
    for (const kind of ['local', 'lattice', 'propagated', 'endpoint', 'created', 'networkInterface']) {
      expect(routes).toMatch(new RegExp(`${kind}: probe\\('${kind}'\\),`));
    }
    expect(routes).toMatch(/aws\.ec2\.getRouteTablesOutput\(\{ filters \}\)\.ids\.apply\(probeMatched\)/);
    expect(routes).toMatch(/const probe = \(kind: FixedProbe\) => lookup\(routeProbeFilters\(routeTableId, kind\)\);/);
    expect(routes).toMatch(
      /const otherPrefixList = \$util\.all\(\[prefixListIds, dataEndpoint\]\)\.apply\(\(\[ids, endpoint\]\) => \{/
    );
    expect(routes).toMatch(
      /const filters = otherPrefixListFilters\(routeTableId, ids, endpoint\?\.prefixListId\);\s*return filters \? lookup\(filters\) : \$output\(false\);/
    );
    expect(routes).toMatch(/otherPrefixList,\s*data: dataEndpoint,/);
    expect(routes).toMatch(
      /\.apply\(\(\{ routes, data, \.\.\.probes \}\) => tableRoutes\(routes, probes, routeTableId, data\)\)/
    );
  });

  it('exports the data endpoint only from a stage whose own network has one', () => {
    expect(functionBody('createCallableFunctionRuntime')).toMatch(
      /return \{ fn, subnetIds: network\.subnetIds, dataEndpointId: dataEndpoint\?\.id \};/
    );
  });

  it('creates the dedicated VPC only on the stages the repository treats as long-lived', () => {
    expect(source).toMatch(/const longLivedStage = PRODUCTION_STAGES\.includes\(\$app\.stage\);/);
    expect(source).toMatch(/import \{[^}]*\bPRODUCTION_STAGES\b[^}]*\} from '\.\/constants';/);
    expect(source.match(/\bdedicatedNetwork\(/g)).toHaveLength(2);
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
    expect(source).toMatch(/export const callableFunctionDataEndpointId = runtime\?\.dataEndpointId;/);
    const config = stripComments(read('sst.config.ts'));
    expect(config).toMatch(
      /\bcallableFunctionSubnetIds,\s*callableFunctionDataEndpointId,\s*\} = await import\('\.\/infra'\);/
    );
    const outputs = balanced(config, config.lastIndexOf('return {'), '{', '}');
    expect(outputs).toMatch(/\bcallableFunctionSubnetIds,\s*callableFunctionDataEndpointId,/);
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
    const duration = declaration('aws.cloudwatch.MetricAlarm', 'CallableFunctionRuntimeDuration');
    expect(duration).toMatch(
      /threshold:\s*CALLABLE_FUNCTION_LAMBDA_TIMEOUT_SECONDS \* 1000 - CALLABLE_FUNCTION_PARENT_MARGIN_MS,/
    );
    const throttles = declaration('aws.cloudwatch.MetricAlarm', 'CallableFunctionRuntimeThrottles');
    expect(throttles).toMatch(/threshold:\s*0,/);
    expect(throttles).toMatch(/comparisonOperator:\s*'GreaterThanThreshold',/);
    expect(source).toMatch(/period:\s*300,/);
    expect(source).toMatch(/evaluationPeriods:\s*1,/);
    expect(source).toMatch(/dimensions:\s*\{\s*FunctionName:\s*fn\.name\s*\}/);
  });

  it('creates the alarms with the function, whenever the alarm topic exists', () => {
    expect(functionBody('createCallableFunctionRuntime')).toMatch(
      /if \(dlqAlarmTopic\) createAlarms\(fn, dlqAlarmTopic\);/
    );
    expect(source).toMatch(/alarmActions:\s*\[topic\.arn\]/);
  });
});

describe('callable function data bucket', () => {
  const data = stripComments(read('infra/callableFunctionData.ts'));
  const policyModule = stripComments(read('infra/callableFunctionDataPolicy.ts'));
  const web = stripComments(read('infra/web.ts'));

  it('is one private, encrypted bucket per stage, kept on the long-lived stages', () => {
    expect(data.match(/new aws\.s3\.Bucket\(/g)).toHaveLength(1);
    expect(data).toMatch(
      /new aws\.s3\.Bucket\(\s*'CallableFunctionDataBucket',\s*\{ forceDestroy: !retained \},\s*\{ retainOnDelete: retained \}\s*\)/
    );
    expect(data).toMatch(/const retained = PRODUCTION_STAGES\.includes\(\$app\.stage\);/);
    expect(data).toMatch(
      /new aws\.s3\.BucketPublicAccessBlock\('CallableFunctionDataPublicAccessBlock', \{\s*bucket: bucket\.bucket,\s*\.\.\.BLOCK_ALL_PUBLIC_ACCESS,\s*\}\)/
    );
    expect(data).toMatch(/import \{ BLOCK_ALL_PUBLIC_ACCESS \} from '\.\/bucketSecurity';/);
    const encryption = balanced(data, data.indexOf("'CallableFunctionDataEncryption',"), '{', '}');
    expect(encryption).toMatch(/bucket: bucket\.bucket,/);
    expect(encryption).toMatch(/sseAlgorithm: 'AES256'/);
    expect(data).not.toMatch(/\bpolicy\b|website|acl/i);
    // CORS for the owner's browser reads only: GET, from the app's own origins.
    const cors = balanced(data, data.indexOf("'CallableFunctionDataCors',"), '{', '}');
    expect(cors).toMatch(/allowedOrigins: getAllowedOrigins\(domain, \$app\.stage\), allowedMethods: \['GET'\]/);
    expect(data.match(/allowedMethods/g)).toHaveLength(1);
    expect(functionBody('secureDataBucket', data)).toMatch(
      /'CallableFunctionDataPublicAccessBlock'[^]*'CallableFunctionDataEncryption'/
    );
  });

  it('creates no bucket, variable, or grant on a stage that names subnets, and says so on the deploy', () => {
    expect(data).toMatch(
      /const onNamedSubnets = namedSubnetIdsOf\(process\.env\.CALLABLE_FUNCTION_SUBNET_IDS\)\.length > 0;/
    );
    expect(data).toMatch(
      /export const callableFunctionDataBucket = onNamedSubnets\s*\? undefined\s*: new aws\.s3\.Bucket\('CallableFunctionDataBucket',/
    );
    expect(data.match(/secureDataBucket\(/g)).toHaveLength(2);
    expect(data).toMatch(
      /export const callableFunctionDataPublicAccessBlock = callableFunctionDataBucket\s*\? secureDataBucket\(callableFunctionDataBucket\)\s*: undefined;/
    );
    expect(data).toMatch(
      /if \(onNamedSubnets\) \{\s*console\.warn\(\s*'Function data is not available on this stage: [^']*'\s*\);/
    );
    expect(data).toMatch(/export const callableFunctionDataForWeb: DataGrant = callableFunctionDataBucket\s*\?/);
    expect(data).toMatch(/export const callableFunctionDataForEraser: DataGrant = callableFunctionDataBucket\s*\?/);
    expect(data.match(/: \{ environment: \{\}, permissions: \[\] \};/g)).toHaveLength(2);
  });

  it('takes the policy that refuses reads outside the endpoint and writes by all but the dispatcher', () => {
    expect(policyModule.match(/new aws\.s3\.BucketPolicy\(/g)).toHaveLength(1);
    expect(policyModule).toMatch(
      /if \(web\.nodes\.server && callableFunctionDataBucket && callableFunctionDataPublicAccessBlock\) \{\s*const browserReader = new aws\.iam\.Role\('CallableFunctionDataBrowserReader', \{[\s\S]*?\}\);\s*new aws\.iam\.RolePolicy\('CallableFunctionDataBrowserReaderPolicy', \{[\s\S]*?\}\);\s*const names = \$util\.all\(\[\s*callableFunctionDataBucket\.arn,\s*web\.nodes\.server\.nodes\.role\.arn,\s*browserReader\.arn,\s*\$util\.all\(\[\s*accountErasureQueueSubscription\.nodes\.function\.nodes\.role\.arn,\s*accountDeletionSweep\?\.nodes\.function\.nodes\.role\.arn \?\? '',\s*\]\),\s*callableFunctionDataEndpointId \?\? '',\s*\]\);\s*new aws\.s3\.BucketPolicy\(\s*'CallableFunctionDataPolicy',/
    );
    expect(policyModule).toMatch(/bucket: callableFunctionDataBucket\.bucket,/);
    expect(policyModule).toMatch(
      /policy: names\.apply\(\(\[bucketArn, dispatcherRoleArn, browserReaderRoleArn, eraserRoleArns, endpointId\]\) =>\s*JSON\.stringify\(\s*callableFunctionDataBucketPolicy\(\{\s*bucketArn,\s*dispatcherRoleArn,\s*browserReaderRoleArn,\s*eraserRoleArns,\s*endpointId,\s*\}\)\s*\)\s*\),/
    );
    expect(policyModule).toMatch(/import \{ accountErasureQueueSubscription \} from '\.\/queues';/);
    expect(policyModule).toMatch(/import \{ accountDeletionSweep \} from '\.\/cron';/);
    expect(policyModule).toMatch(/\{ dependsOn: \[callableFunctionDataPublicAccessBlock\] \}/);
    expect(policyModule).toMatch(/import \{ callableFunctionDataEndpointId \} from '\.\/callableFunctionRuntime';/);
    const index = stripComments(read('infra/index.ts'));
    const at = (module: string) => index.indexOf(`export * from './${module}';`);
    expect(at('callableFunctionData')).toBeGreaterThan(-1);
    expect(at('callableFunctionData')).toBeLessThan(at('callableFunctionRuntime'));
    expect(at('callableFunctionDataPolicy')).toBeGreaterThan(at('web'));
  });

  it("creates the browser-link reader role under the name the web API function is granted, trusted by that function's role", () => {
    expect(policyModule.match(/new aws\.iam\.Role\(/g)).toHaveLength(1);
    expect(policyModule).toMatch(
      /new aws\.iam\.Role\('CallableFunctionDataBrowserReader', \{\s*name: callableFunctionDataBrowserReaderRoleName,\s*assumeRolePolicy: web\.nodes\.server\.nodes\.role\.arn\.apply\(arn =>\s*JSON\.stringify\(callableFunctionDataBrowserReaderTrustPolicy\(arn\)\)\s*\),\s*\}\);/
    );
    expect(policyModule).toMatch(
      /new aws\.iam\.RolePolicy\('CallableFunctionDataBrowserReaderPolicy', \{\s*role: browserReader\.name,\s*policy: callableFunctionDataBucket\.arn\.apply\(arn => JSON\.stringify\(callableFunctionDataBrowserReaderPolicy\(arn\)\)\),\s*\}\);/
    );
    expect(data).toMatch(
      /export const callableFunctionDataBrowserReaderRoleName = `\$\{\$app\.name\}-\$\{\$app\.stage\}-fn-data-browser`;/
    );
    expect(data).toMatch(
      /const browserReaderRoleArn = \$interpolate`arn:\$\{aws\.getPartitionOutput\(\)\.partition\}:iam::\$\{aws\.getCallerIdentityOutput\(\)\.accountId\}:role\/\$\{callableFunctionDataBrowserReaderRoleName\}`;/
    );
    expect(data).toMatch(
      /const browserReaderForWeb: DataGrant = \$dev\s*\? \{ environment: \{\}, permissions: \[\] \}\s*: \{\s*environment: \{ CALLABLE_FUNCTION_DATA_BROWSER_ROLE_ARN: browserReaderRoleArn \},\s*permissions: \[\{ actions: \['sts:AssumeRole'\], resources: \[browserReaderRoleArn\] \}\],\s*\};/
    );
  });

  it("gives the web API function the bucket's name and its data/ object permissions by statement, not by link", () => {
    expect(data).toMatch(
      /environment: \{\s*CALLABLE_FUNCTION_DATA_BUCKET: callableFunctionDataBucket\.bucket,\s*\.\.\.browserReaderForWeb\.environment,\s*\},/
    );
    expect(data).toMatch(
      /permissions: \[\s*\{\s*actions: FUNCTION_DATA_DISPATCHER_ACTIONS,\s*resources: \[\$interpolate`\$\{callableFunctionDataBucket\.arn\}\/\$\{FUNCTION_DATA_KEY_PREFIX\}\*`\],\s*\},\s*listDataKeys\(callableFunctionDataBucket\),\s*\.\.\.browserReaderForWeb\.permissions,\s*\],/
    );
    expect(data).toMatch(
      /permissions: \[\s*\{\s*actions: FUNCTION_DATA_ERASER_ACTIONS,\s*resources: \[\$interpolate`\$\{callableFunctionDataBucket\.arn\}\/\$\{FUNCTION_DATA_KEY_PREFIX\}\*`\],\s*\},\s*listDataKeys\(callableFunctionDataBucket\),\s*\],/
    );
    expect(data).toMatch(
      /actions: \['s3:ListBucket'\],\s*resources: \[bucket\.arn\],\s*conditions: \[\{ test: 'StringLike', variable: 's3:prefix', values: \[`\$\{FUNCTION_DATA_KEY_PREFIX\}\*`\] \}\],/
    );
    const queues = stripComments(read('infra/queues.ts'));
    const erasure = queues.slice(queues.indexOf('const accountErasureQueueSubscription'));
    expect(erasure.slice(0, erasure.indexOf('SINGLE_RECORD_BATCH'))).toMatch(
      /\.\.\.callableFunctionDataForEraser\.permissions,[\s\S]*\.\.\.callableFunctionDataForEraser\.environment,/
    );
    const cron = stripComments(read('infra/cron.ts'));
    const sweep = cron.slice(cron.indexOf('const accountDeletionSweep ='));
    const sweepFunction = sweep.slice(0, sweep.indexOf('transform: accountDeletionSweepDeadLetter.functionTarget'));
    expect(sweepFunction).toMatch(/environment: \{[^}]*\.\.\.callableFunctionDataForEraser\.environment,\s*\}/);
    expect(sweepFunction).toMatch(/permissions: \[[\s\S]*\.\.\.callableFunctionDataForEraser\.permissions,\s*\],/);
    expect(cron.match(/callableFunctionDataFor\w*/g)?.sort()).toEqual([
      'callableFunctionDataForEraser',
      'callableFunctionDataForEraser',
      'callableFunctionDataForEraser',
    ]);
    expect(web).toMatch(/\.\.\.callableFunctionDataForWeb\.permissions,/);
    expect(web).toMatch(/\.\.\.callableFunctionDataForWeb\.environment,/);
    expect(balanced(web, web.indexOf('link: ['), '[', ']')).not.toMatch(/callableFunctionData/);
    expect(web.match(/callableFunctionData\w*/g)?.sort()).toEqual([
      'callableFunctionData',
      'callableFunctionDataForWeb',
      'callableFunctionDataForWeb',
      'callableFunctionDataForWeb',
    ]);
    expect(web).not.toMatch(/CALLABLE_FUNCTION_DATA/);
  });
});
