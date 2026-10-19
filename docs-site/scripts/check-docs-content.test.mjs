import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanText, checkTopLevel, KNOWN_TOP_LEVEL } from './check-docs-content.mjs';

const rulesFor = (text) => scanText(text).map((f) => f.rule);

const cases = [
  ['aws-account-id', 'account 210987654321 here', 'account 123456789012 here'],
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

test('ignore marker skips only the next line', () => {
  const text = '<!-- docs-guard-ignore-next-line -->\nmail jane@realco.io\nmail jane@realco.io';
  assert.deepEqual(scanText(text), [{ line: 3, rule: 'email' }]);
});

test('unknown top-level directory is reported', () => {
  assert.deepEqual(checkTopLevel([...KNOWN_TOP_LEVEL, 'brand-new']), ['brand-new']);
  assert.deepEqual(checkTopLevel(KNOWN_TOP_LEVEL), []);
});
