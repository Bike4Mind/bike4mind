#!/usr/bin/env node
// Creates or updates, then publishes, the CloudFront viewer-response function that every
// preview stage in an account shares (infra/preview-shared-response-function.md). Run it by
// hand, once per preview account, with that account's credentials; preview stages only
// attach it and never create, change or delete it.
//
//   node scripts/preview-shared-response-function.mjs            create/update + publish
//   node scripts/preview-shared-response-function.mjs --check    exit 1 when LIVE is stale
//   node scripts/preview-shared-response-function.mjs --print    show the generated code
//
// Options: --name <function name> (default bike4mind-preview-shared-viewer-response)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { sharedPreviewResponseFunctionCode } from '../infra/routerFunctionCode.ts';

const DEFAULT_NAME = 'bike4mind-preview-shared-viewer-response';
const COMMENT =
  'Shared viewer-response function for bike4mind preview stages; managed by scripts/preview-shared-response-function.mjs';

const { values } = parseArgs({
  options: {
    name: { type: 'string', default: DEFAULT_NAME },
    check: { type: 'boolean', default: false },
    print: { type: 'boolean', default: false },
  },
});

const code = sharedPreviewResponseFunctionCode();

if (values.print) {
  process.stdout.write(code);
  process.exit(0);
}

function aws(args) {
  return execFileSync('aws', ['cloudfront', ...args, '--output', 'json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function liveCode(name, dir) {
  const out = join(dir, 'live.js');
  try {
    aws(['get-function', '--name', name, '--stage', 'LIVE', out]);
  } catch (error) {
    if (String(error.stderr).includes('NoSuchFunctionExists')) return null;
    throw error;
  }
  return readFileSync(out, 'utf8');
}

const dir = mkdtempSync(join(tmpdir(), 'preview-shared-response-'));
try {
  const live = liveCode(values.name, dir);
  const describe = live === null ? null : JSON.parse(aws(['describe-function', '--name', values.name]));
  const arn = describe?.FunctionSummary?.FunctionMetadata?.FunctionARN;

  if (live === code) {
    console.log(`LIVE is current: ${arn}`);
    process.exit(0);
  }

  if (values.check) {
    console.error(
      live === null
        ? `${values.name} does not exist`
        : `LIVE of ${values.name} differs from infra/routerFunctionCode.ts`
    );
    process.exit(1);
  }

  const codeFile = join(dir, 'function.js');
  writeFileSync(codeFile, code);
  const config = [
    '--function-config',
    `Comment=${COMMENT},Runtime=cloudfront-js-2.0`,
    '--function-code',
    `fileb://${codeFile}`,
  ];

  const written = JSON.parse(
    live === null
      ? aws(['create-function', '--name', values.name, ...config])
      : aws(['update-function', '--name', values.name, '--if-match', describe.ETag, ...config])
  );
  const published = JSON.parse(aws(['publish-function', '--name', values.name, '--if-match', written.ETag]));
  console.log(
    `${live === null ? 'Created' : 'Updated'} and published ${published.FunctionSummary.FunctionMetadata.FunctionARN}`
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
