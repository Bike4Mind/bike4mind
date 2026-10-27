import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanText, checkTopLevel, KNOWN_TOP_LEVEL } from './check-docs-content.mjs';

const rulesFor = (text) => scanText(text).map((f) => f.rule);

const cases = [
  ['aws-account-id', 'account 210987654321 here', 'account 123456789012 here'],
  ['aws-account-id-dashed', 'account 2109-8765-4321 here', 'account 1234-5678-9012 here'],
  ['aws-arn', 'arn:aws:iam::210987654321:role/x', 'arn:aws:iam::123456789012:role/x'],
  ['aws-arn', null, 'arn:aws:iam::<account-id>:role/x'],
  ['aws-access-key-id', 'key AKIAABCDEFGHIJKLMNOP', 'key AKIAEXAMPLE'],
  ['private-key-block', '-----BEGIN RSA PRIVATE KEY-----', '-----BEGIN PUBLIC KEY-----'],
  ['jwt', 'tok eyJhbGciOi.eyJzdWIiOi.abcDEF_-123', 'tok eyJ only'],
  ['credentialed-url', 'postgres://admin:s3cretvalue@db.host/x', 'postgres://user:password@db.host/x'],
  ['credentialed-url', null, 'mongodb://u:<password>@host/x'],
  ['token-prefix', 'ghp_' + 'a'.repeat(36), 'ghp_personal_token'],
  ['token-prefix', 'sk-ant-' + 'a'.repeat(30), 'sk-ant-<your-key>'],
  ['internal-hostname', 'host svc.internal:80', 'host svc.internal-service.example.com'],
  ['internal-hostname', 'host db.corp', 'host db.corporate.example.com'],
  ['email', 'mail jane@realco.io', 'mail dev@example.com'],
  ['email', null, 'mail support@bike4mind.com'],
  ['email', 'write mailto:jane@realco.io', 'write mailto:dev@example.com'],
  ['email', null, 'clone git@gitlab.com:org/repo.git'],
  ['email', null, 'clone ssh://git@github.com/org/repo.git'],
  ['aws-arn-no-account', 'arn:aws:s3:::acme-prod-uploads/*', 'arn:aws:s3:::bike4mind-email-ingestion-[region]'],
  ['aws-arn-no-account', null, 'arn:aws:s3:::<bucket-name>/*'],
  ['aws-resource-host', 'https://d1a2b3c4d5e6f7.cloudfront.net/x', 'https://d1234abcxyz.cloudfront.net/x'],
  ['aws-resource-host', null, 'https://dEXAMPLE123.cloudfront.net/x'],
  ['aws-resource-host', 'acme-prod-uploads.s3.amazonaws.com', 'my-bucket.s3.amazonaws.com'],
  ['aws-resource-host', 'acme-prod-uploads.s3.us-east-1.amazonaws.com', 'example-bucket.s3.us-east-1.amazonaws.com'],
  ['aws-resource-host', 'https://s3.us-east-1.amazonaws.com/acme-prod-uploads/key', 'https://s3.us-east-1.amazonaws.com/<bucket>/key'],
  ['aws-resource-host', 'https://a1b2c3d4e5.execute-api.us-east-1.amazonaws.com/prod', 'https://xxxxxxxxxx.execute-api.us-east-1.amazonaws.com/prod'],
  ['token-prefix', 'gho_' + 'a'.repeat(36), 'gho_<token>'],
  ['token-prefix', 'ghs_' + 'a'.repeat(36), 'ghs_example'],
  ['token-prefix', 'ghu_' + 'a'.repeat(36), 'ghu_xxxx'],
  ['token-prefix', 'ghr_' + 'a'.repeat(36), 'ghr_'],
  ['token-prefix', 'xoxa-2-123456-abcdefghij', 'xoxa-<token>'],
  ['token-prefix', 'xapp-1-A0123-abcdefghij', 'xapp-<token>'],
  ['token-prefix', 'sk_live_' + 'a'.repeat(24), 'sk_live_<your-key>'],
  ['token-prefix', 'rk_live_' + 'a'.repeat(24), 'rk_live_xxxxxxxxxxxxxxxxxxxx'],
  ['token-prefix', 'sk-' + 'a1B2'.repeat(12), 'sk-' + 'x'.repeat(48)],
  ['tracker-reference', 'see https://github.com/realorg/repo/issues/12', 'see https://github.com/org/repo/issues/12'],
  ['tracker-reference', 'see realorg/repo#12', 'see https://github.com/bike4mind/bike4mind'],
];

for (const [rule, bad, good] of cases) {
  if (bad) {
    test(`${rule}: flags ${bad.slice(0, 30)}`, () => {
      assert.ok(rulesFor(bad).includes(rule));
    });
  }
  test(`${rule}: allows ${good.slice(0, 30)}`, () => {
    assert.ok(!rulesFor(good).includes(rule));
  });
}

const apiFindings = (text, path = 'api/x.md') => scanText(text, path).map((f) => f.rule);

for (const [bad, good] of [
  ['use claude-3-5-sonnet', 'use claude-sonnet-5'],
  ['use claude-3-opus', 'use claude-opus-4'],
  ['use gpt-3.5-turbo', 'use gpt-4o'],
  ['use gemini-pro', 'use gemini-2.5-pro'],
  ['use gpt-4', 'use gpt-4.1'],
  ['use gpt-4-turbo', 'use gpt-4o-realtime-preview'],
]) {
  test(`retired-model-id (api/): flags ${bad}`, () => {
    assert.ok(apiFindings(bad).includes('retired-model-id'));
    assert.ok(!apiFindings(good).includes('retired-model-id'));
  });
}

test('stale-api-keys-menu-path (api/): flags the old menu path', () => {
  for (const bad of ['Settings -> API Keys', 'Settings > API Keys', 'Settings \u2192 API Keys', 'Settings &gt; API Keys']) {
    assert.ok(apiFindings(bad).includes('stale-api-keys-menu-path'), bad);
  }
  assert.ok(!apiFindings('Profile menu -> More -> API Keys').includes('stale-api-keys-menu-path'));
});

test('api-scoped rules skip files outside api/', () => {
  assert.deepEqual(scanText('model claude-3-opus', 'cli/features.md'), []);
  assert.deepEqual(scanText('model claude-3-opus'), []);
});

test('ignore marker skips only the next line', () => {
  const text = '<!-- docs-guard-ignore-next-line -->\nmail jane@realco.io\nmail jane@realco.io';
  assert.deepEqual(scanText(text), [{ line: 3, rule: 'email' }]);
});

test('unknown top-level directory is reported', () => {
  assert.deepEqual(checkTopLevel([...KNOWN_TOP_LEVEL, 'brand-new']), ['brand-new']);
  assert.deepEqual(checkTopLevel(KNOWN_TOP_LEVEL), []);
});
