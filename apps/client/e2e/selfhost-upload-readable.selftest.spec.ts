import { test, expect } from '@playwright/test';
import {
  appPodsArgs,
  buildPayload,
  compareBytes,
  extractSignInCode,
  mutateOneBit,
  parseAppPods,
  podsWereReplaced,
  readUploadReadableConfig,
  restartAppArgs,
  rolloutStatusArgs,
  sha256Hex,
  wrongKeyUrl,
} from './helpers/selfhost-upload-readable';

// Target-free checks of the helpers the live check trusts. Run with:
//   pnpm exec playwright test -c e2e/selfhost-upload-readable.config.ts --project=selftest

const ENV = { SELFHOST_URL: 'http://localhost:3000/', SELFHOST_EMAIL: 'op@example.invalid' };

test.describe('byte comparison', () => {
  const payload = buildPayload('nonce-a');

  test('passes on identical bytes and reports their size and hash', () => {
    expect(compareBytes(payload, Buffer.from(payload))).toEqual({
      ok: true,
      bytes: payload.length,
      sha256: sha256Hex(payload),
    });
  });

  test('fails on a single flipped bit at every offset', () => {
    for (let i = 0; i < payload.length; i++) {
      const mutated = Buffer.from(payload);
      mutated[i] ^= 0x01;
      const verdict = compareBytes(payload, mutated);
      expect(verdict.ok, `a flipped bit at byte ${i} passed`).toBe(false);
    }
  });

  test('fails on the mutation the live check applies', () => {
    const mutated = mutateOneBit(payload);
    expect(mutated.length).toBe(payload.length);
    expect(compareBytes(mutated, payload).ok).toBe(false);
    // The input is left alone, so the bytes that get uploaded are never the mutated ones.
    expect(compareBytes(payload, buildPayload('nonce-a')).ok).toBe(true);
  });

  test('fails on truncated, extended and empty reads', () => {
    expect(compareBytes(payload, payload.subarray(0, payload.length - 1)).ok).toBe(false);
    expect(compareBytes(payload, Buffer.concat([payload, Buffer.from([0])])).ok).toBe(false);
    expect(compareBytes(payload, Buffer.alloc(0)).ok).toBe(false);
  });

  test('fails on a UTF-8 round trip of the payload', () => {
    const decoded = Buffer.from(payload.toString('utf8'), 'utf8');
    expect(compareBytes(payload, decoded).ok).toBe(false);
  });

  test('the payload carries every byte value and differs per nonce', () => {
    expect(new Set(payload).size).toBe(256);
    expect(compareBytes(payload, buildPayload('nonce-b')).ok).toBe(false);
  });
});

test.describe('pod replacement verdict', () => {
  const pod = (name: string, uid: string) => ({ name, uid, images: ['app:1'] });

  test('accepts only a disjoint, non-empty set of pod UIDs', () => {
    expect(podsWereReplaced([pod('a', '1')], [pod('b', '2')])).toEqual({ ok: true });
    expect(podsWereReplaced([pod('a', '1')], [pod('a', '1')]).ok).toBe(false);
    expect(podsWereReplaced([pod('a', '1')], [pod('b', '2'), pod('a', '1')]).ok).toBe(false);
    expect(podsWereReplaced([], [pod('b', '2')]).ok).toBe(false);
    expect(podsWereReplaced([pod('a', '1')], []).ok).toBe(false);
    expect(podsWereReplaced([pod('a', '1')], [pod('b', '')]).ok).toBe(false);
  });

  test('ignores terminating pods when listing', () => {
    const json = JSON.stringify({
      items: [
        { metadata: { name: 'old', uid: '1', deletionTimestamp: '2026-01-01T00:00:00Z' } },
        { metadata: { name: 'new', uid: '2' }, spec: { containers: [{ image: 'app:1' }] } },
      ],
    });
    expect(parseAppPods(json)).toEqual([{ name: 'new', uid: '2', images: ['app:1'] }]);
  });

  test('builds kubectl arguments for the chart app Deployment', () => {
    const kube = { namespace: 'bike4mind-eval', release: 'b4m', context: 'kind-b4m' };
    expect(appPodsArgs(kube)).toEqual([
      '--context',
      'kind-b4m',
      '--namespace',
      'bike4mind-eval',
      'get',
      'pods',
      '--selector',
      'app.kubernetes.io/instance=b4m,app.kubernetes.io/component=app',
      '--output',
      'json',
    ]);
    expect(restartAppArgs({ namespace: 'ns', release: 'r' })).toEqual([
      '--namespace',
      'ns',
      'rollout',
      'restart',
      'deployment/r-app',
    ]);
    expect(rolloutStatusArgs({ namespace: 'ns', release: 'r' }, 90_500).at(-1)).toBe('--timeout=91s');
  });
});

test.describe('configuration', () => {
  test('requires a namespace unless pod replacement is skipped', () => {
    expect(() => readUploadReadableConfig(ENV)).toThrow(/SELFHOST_KUBE_NAMESPACE/);
    expect(readUploadReadableConfig({ ...ENV, SELFHOST_SKIP_POD_REPLACE: 'true' }).kube).toBeUndefined();
    expect(readUploadReadableConfig({ ...ENV, SELFHOST_KUBE_NAMESPACE: 'bike4mind-eval' })).toMatchObject({
      baseUrl: 'http://localhost:3000',
      mailpitUrl: 'http://localhost:8025',
      kube: { namespace: 'bike4mind-eval', release: 'b4m' },
      mutateExpected: false,
    });
  });

  test('rejects values kubectl would read as flags, and malformed input', () => {
    const base = { ...ENV, SELFHOST_KUBE_NAMESPACE: 'ns' };
    expect(() => readUploadReadableConfig({ ...ENV, SELFHOST_KUBE_NAMESPACE: '--all-namespaces' })).toThrow();
    expect(() => readUploadReadableConfig({ ...base, SELFHOST_KUBE_RELEASE: '-o' })).toThrow();
    expect(() => readUploadReadableConfig({ ...base, SELFHOST_KUBE_CONTEXT: '--kubeconfig=x' })).toThrow();
    expect(() => readUploadReadableConfig({ ...base, SELFHOST_URL: 'file:///etc' })).toThrow();
    expect(() => readUploadReadableConfig({ ...base, SELFHOST_EMAIL: '' })).toThrow();
    expect(() => readUploadReadableConfig({ ...base, SELFHOST_MUTATE_EXPECTED: 'yes' })).toThrow();
    expect(() => readUploadReadableConfig({ ...base, SELFHOST_READY_TIMEOUT_MS: '0' })).toThrow();
  });
});

test.describe('sign-in code and wrong-key URL', () => {
  test('reads an 8-digit code and nothing longer or shorter', () => {
    expect(extractSignInCode('Your code is 01234567. It expires in 10 minutes.')).toBe('01234567');
    expect(extractSignInCode('order 123456789 shipped')).toBeUndefined();
    expect(extractSignInCode('pin 1234567')).toBeUndefined();
  });

  test('changes only the object key and keeps the signature', () => {
    const signed = 'http://localhost:19000/b4m-fab-file/user1/abc/file.txt?X-Amz-Signature=deadbeef&X-Amz-Expires=3600';
    const wrong = new URL(wrongKeyUrl(signed, 'n1'));
    expect(wrong.pathname).toBe('/b4m-fab-file/user1/abc/wrong-key-n1-file.txt');
    expect(wrong.search).toBe(new URL(signed).search);
    expect(wrong.origin).toBe('http://localhost:19000');
  });
});
