const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveVersion, builderArgs } = require('./package-local.cjs');

test('uses highest numeric desktop tag, not package baseline or web tags', () => {
  assert.equal(resolveVersion(undefined, 'desktop-v0.5.0\ndesktop-v0.9.0\ndesktop-v0.10.0\ndesktop-v1.0.0\nv2026.10.15.4\ndesktop-v2.0.0-pr.1', 'abcdef'), '0.10.0-local.abcdef');
  assert.throws(() => resolveVersion(undefined, 'desktop-v2.0.0', 'abcdef'), /beta policy/);
});
test('requires tags or explicit version', () => {
  assert.throws(() => resolveVersion(undefined, '', 'abcdef'), /git fetch/);
  assert.equal(resolveVersion('0.5.0', '', 'abcdef'), '0.5.0');
  assert.equal(resolveVersion('1.0.1-test.1', '', 'abcdef'), '1.0.1-test.1');
  for (const value of ['', '01.2.3', '1.2', '1.2.3-test.01', '1.2.3;exit']) {
    assert.throws(() => resolveVersion(value, '', 'abcdef'));
  }
});
test('local mac signs explicitly, Linux does not receive mac options', () => {
  assert.deepEqual(builderArgs(['--mac', '--arm64'], '1.0.0', 'darwin'), ['--mac', '--arm64', '--publish', 'never', '-c.extraMetadata.version=1.0.0', '-c.mac.identity=-']);
  assert.ok(builderArgs(['--dir'], '1.0.0', 'darwin', 'Developer ID Application: Example').includes('-c.mac.identity=Developer ID Application: Example'));
  assert.ok(!builderArgs(['--linux'], '1.0.0', 'darwin').some(arg => arg.includes('mac.identity')));
});
test('rejects alternate publish/version/signing flags', () => {
  for (const arg of ['--publish=always', '-c.extraMetadata.version=0.1.0', '-c.mac.identity=null', '-c.forceCodeSigning=false']) {
    assert.throws(() => builderArgs([arg], '1.0.0', 'darwin'));
  }
});
