/**
 * @vitest-environment node
 *
 * Pins which Lambdas run outside the VPC, and keeps docs/architecture/lambda-vpc-audit.md in step
 * with infra/. Text-matched, not executed: infra/ is an SST program and does not load outside `sst`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { balanced, stripComments } from './helpers/infraSource';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

// Detaching a Lambda that opens MongoDB (or calls SearXNG) breaks it at runtime, not at deploy.
// Add a handler here only after tracing that it reaches neither, and record it in the audit doc.
const OUTSIDE_VPC = [
  'apps/client/server/websocket/heartbeat.func',
  'apps/workers/src/cron/providerUsagePoll.handler',
  'apps/workers/src/events/dlqAlarmToSlack.handler',
  'apps/workers/src/events/serviceHealthAlarmToSlack.handler',
  'apps/workers/src/events/wafAlarmToSlack.handler',
  'apps/workers/src/mcp/remoteMcpCall.handler',
  'apps/workers/src/media/imageProcessor.handler',
  'apps/workers/src/media/publishThumbnailRenderer.handler',
];

/** The object literal a `handler:` key sits in: the Lambda's own declaration. */
function enclosingObject(source: string, index: number): string {
  let depth = 0;
  for (let i = index; i >= 0; i--) {
    if (source[i] === '}') depth++;
    else if (source[i] === '{' && depth-- === 0) return balanced(source, i, '{', '}');
  }
  throw new Error(`No enclosing object before index ${index}`);
}

function declaredHandlers(): Map<string, { file: string; inVpc: boolean }> {
  const handlers = new Map<string, { file: string; inVpc: boolean }>();
  const files = readdirSync(path.join(REPO_ROOT, 'infra')).filter(name => name.endsWith('.ts'));
  for (const name of files) {
    const file = `infra/${name}`;
    const source = stripComments(read(file));
    for (const match of source.matchAll(/^\s*handler:\s*'([^']+)'/gm)) {
      const handler = match[1];
      if (handlers.has(handler)) throw new Error(`${handler} is declared twice; key this guard by declaration.`);
      const declaration = enclosingObject(source, match.index);
      handlers.set(handler, { file, inVpc: /\bvpc:\s*lambdaVpc\b/.test(declaration) });
    }
  }
  return handlers;
}

const handlers = declaredHandlers();

describe('Lambda VPC attachments', () => {
  it('finds the handler declarations it guards', () => {
    expect(handlers.size).toBeGreaterThan(140);
  });

  it('runs exactly the audited handlers outside the VPC', () => {
    const outside = [...handlers].filter(([, { inVpc }]) => !inVpc).map(([handler]) => handler);
    expect(outside.sort()).toEqual([...OUTSIDE_VPC].sort());
  });

  it('keeps the image processor free of database and network clients', () => {
    expect(stripComments(read('infra/imageProcessor.ts'))).not.toMatch(/\bvpc\b/i);
    const imports = [...read('apps/workers/src/media/imageProcessor.ts').matchAll(/from '([^']+)'/g)].map(m => m[1]);
    expect(imports.sort()).toEqual(['@bike4mind/observability', '@bike4mind/utils/imageResize', 'jimp']);
  });

  it('keeps the heartbeat route database-free', () => {
    const handler = read('apps/client/server/websocket/heartbeat.ts');
    expect(stripComments(handler)).toMatch(/\{\s*skipDatabase:\s*true\s*\}/);
    expect(handler).not.toMatch(/@bike4mind\/database|connectDB/);
  });
});

describe('gateway endpoints', () => {
  const source = stripComments(read('infra/vpc.ts'));

  it('adds S3 and DynamoDB gateway endpoints on the private route tables', () => {
    expect(source).toMatch(/GATEWAY_ENDPOINT_SERVICES = \['s3', 'dynamodb'\] as const/);
    const endpoints = source.slice(source.indexOf('export const gatewayEndpoints'));
    expect(endpoints).toMatch(/new aws\.ec2\.VpcEndpoint\(/);
    expect(endpoints).toMatch(/vpcEndpointType:\s*'Gateway'/);
    expect(endpoints).toMatch(/routeTableIds:\s*vpc\.nodes\.privateRouteTables/);
    expect(endpoints).toMatch(/com\.amazonaws\.\$\{aws\.getRegionOutput\(\)\.name\}\.\$\{service\}/);
  });

  // A shared VPC's route tables take one gateway endpoint per service, so a per-stage endpoint
  // there would fail every deploy after the first.
  it('only for the VPC this stack provisions', () => {
    expect(source).toMatch(/export const gatewayEndpoints = vpc\s*\?\s*GATEWAY_ENDPOINT_SERVICES\.map\(/);
    expect(source).toMatch(/\)\s*:\s*\[\];/);
  });
});

describe('docs/architecture/lambda-vpc-audit.md', () => {
  const rows = new Map(
    [
      ...read('docs/architecture/lambda-vpc-audit.md').matchAll(
        /^\| `([^`]+)` \| `(infra\/[^`]+)` \|.*?\| (Yes|No)\b[^|]*\|[^|]*\|$/gm
      ),
    ].map(m => [m[1], { file: m[2], inVpc: m[3] === 'Yes' }] as const)
  );

  it('lists every declared handler with its current attachment', () => {
    expect([...rows].sort()).toEqual([...handlers].sort());
  });
});
