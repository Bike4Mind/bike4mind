import { createHmac, randomBytes } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type SecretName = 'HMAC_SIGNING_SECRET' | 'HMAC_SIGNING_SECRET_PREVIOUS' | 'SECRET_ENCRYPTION_KEY';

const state = vi.hoisted(() => ({
  values: {} as Partial<Record<string, string>>,
  throwOnValue: new Set<string>(),
  throwOnResource: new Set<string>(),
  valueReads: [] as string[],
}));

vi.mock('sst', () => ({
  Resource: new Proxy(
    {},
    {
      get(_target, name) {
        const key = String(name);
        if (state.throwOnResource.has(key)) throw new Error(`"${key}" is not linked`);
        if (!(key in state.values) && !state.throwOnValue.has(key)) return undefined;
        return {
          get value() {
            state.valueReads.push(key);
            if (state.throwOnValue.has(key)) throw new Error(`"${key}" is not linked`);
            return state.values[key];
          },
        };
      },
    }
  ),
}));

import { signingKey, verificationKeys, type SigningPurpose } from './signingKeys';

const PURPOSES: SigningPurpose[] = ['search-image-url', 'telemetry-salt', 'purge-receipt'];
const hex = () => randomBytes(32).toString('hex');
const derived = (root: string, purpose: SigningPurpose) =>
  createHmac('sha256', root).update(`b4m-signing/${purpose}/v1`).digest('hex');
const configure = (values: Partial<Record<SecretName, string>>) => {
  state.values = { ...values };
};

describe('signing keys', () => {
  beforeEach(() => {
    state.values = {};
    state.throwOnValue.clear();
    state.throwOnResource.clear();
    state.valueReads.length = 0;
  });

  describe('without HMAC_SIGNING_SECRET', () => {
    it('derives a distinct key per purpose from the encryption key and still verifies the raw one', () => {
      const encryptionKey = hex();
      configure({ SECRET_ENCRYPTION_KEY: encryptionKey });
      const keys = PURPOSES.map(purpose => signingKey(purpose));
      expect(new Set(keys).size).toBe(PURPOSES.length);
      PURPOSES.forEach((purpose, i) => {
        expect(keys[i]).toBe(derived(encryptionKey, purpose));
        expect(keys[i]).not.toBe(encryptionKey);
        expect(verificationKeys(purpose)).toEqual([keys[i], encryptionKey]);
      });
    });

    it('never signs one purpose with a key another purpose signs with', () => {
      configure({ SECRET_ENCRYPTION_KEY: hex() });
      const receiptKey = signingKey('purge-receipt');
      for (const purpose of PURPOSES.filter(p => p !== 'purge-receipt')) {
        expect(verificationKeys(purpose)).not.toContain(receiptKey);
      }
    });

    it('ignores the previous slot', () => {
      const encryptionKey = hex();
      configure({ SECRET_ENCRYPTION_KEY: encryptionKey, HMAC_SIGNING_SECRET_PREVIOUS: hex() });
      for (const purpose of PURPOSES) {
        expect(signingKey(purpose)).toBe(derived(encryptionKey, purpose));
        expect(verificationKeys(purpose)).toEqual([derived(encryptionKey, purpose), encryptionKey]);
      }
    });

    it.each(['not-configured', '', 'change-me-openssl-rand-hex-32', 'replace-with-generated-secret'])(
      'treats %j as unset for the dedicated secret',
      placeholder => {
        const encryptionKey = hex();
        configure({ HMAC_SIGNING_SECRET: placeholder, SECRET_ENCRYPTION_KEY: encryptionKey });
        expect(signingKey('search-image-url')).toBe(derived(encryptionKey, 'search-image-url'));
        expect(verificationKeys('search-image-url')).toEqual([
          derived(encryptionKey, 'search-image-url'),
          encryptionKey,
        ]);
      }
    );

    it('returns an empty key and no verification keys when nothing is configured', () => {
      configure({});
      expect(signingKey('search-image-url')).toBe('');
      expect(verificationKeys('search-image-url')).toEqual([]);
    });

    it.each(['my-secret-placeholder-value', 'not-configured', 'change-me-openssl-rand-hex-32'])(
      'signs with a key derived from a %j encryption key but does not accept it for verification',
      placeholder => {
        configure({ SECRET_ENCRYPTION_KEY: placeholder });
        expect(signingKey('telemetry-salt')).toBe(derived(placeholder, 'telemetry-salt'));
        expect(verificationKeys('telemetry-salt')).toEqual([]);
      }
    );

    it('returns an empty key for an empty encryption key', () => {
      configure({ SECRET_ENCRYPTION_KEY: '' });
      expect(signingKey('telemetry-salt')).toBe('');
      expect(verificationKeys('telemetry-salt')).toEqual([]);
    });
  });

  describe('with HMAC_SIGNING_SECRET', () => {
    it('derives a distinct key per purpose from the dedicated secret', () => {
      const root = hex();
      const encryptionKey = hex();
      configure({ HMAC_SIGNING_SECRET: root, SECRET_ENCRYPTION_KEY: encryptionKey });
      const keys = PURPOSES.map(purpose => signingKey(purpose));
      expect(new Set(keys).size).toBe(PURPOSES.length);
      PURPOSES.forEach((purpose, i) => {
        expect(keys[i]).toBe(derived(root, purpose));
        expect(keys[i]).not.toBe(root);
        expect(keys[i]).not.toBe(encryptionKey);
        expect(verificationKeys(purpose)).toEqual([keys[i]]);
      });
    });

    it('never reads the encryption key', () => {
      configure({ HMAC_SIGNING_SECRET: hex() });
      state.throwOnValue.add('SECRET_ENCRYPTION_KEY');
      for (const purpose of PURPOSES) {
        expect(() => signingKey(purpose)).not.toThrow();
        expect(() => verificationKeys(purpose)).not.toThrow();
      }
      expect(state.valueReads).not.toContain('SECRET_ENCRYPTION_KEY');
    });

    it('adds the previous secret as a derived key and then a raw key, newest first', () => {
      const root = hex();
      const previous = hex();
      configure({ HMAC_SIGNING_SECRET: root, HMAC_SIGNING_SECRET_PREVIOUS: previous, SECRET_ENCRYPTION_KEY: hex() });
      for (const purpose of PURPOSES) {
        expect(verificationKeys(purpose)).toEqual([derived(root, purpose), derived(previous, purpose), previous]);
        expect(signingKey(purpose)).toBe(derived(root, purpose));
      }
    });

    it.each(['not-configured', 'my-secret-placeholder-value', '', 'change-me-openssl-rand-hex-32'])(
      'does not accept a %j previous slot',
      placeholder => {
        const root = hex();
        configure({ HMAC_SIGNING_SECRET: root, HMAC_SIGNING_SECRET_PREVIOUS: placeholder });
        expect(verificationKeys('purge-receipt')).toEqual([derived(root, 'purge-receipt')]);
      }
    );

    it('treats a placeholder dedicated secret as unset even when a previous secret is present', () => {
      const encryptionKey = hex();
      configure({
        HMAC_SIGNING_SECRET: 'my-secret-placeholder-value',
        HMAC_SIGNING_SECRET_PREVIOUS: hex(),
        SECRET_ENCRYPTION_KEY: encryptionKey,
      });
      expect(signingKey('telemetry-salt')).toBe(derived(encryptionKey, 'telemetry-salt'));
      expect(verificationKeys('telemetry-salt')).toEqual([derived(encryptionKey, 'telemetry-salt'), encryptionKey]);
    });
  });

  describe('unlinked resources', () => {
    it.each([
      ['a getter that throws', state.throwOnValue],
      ['a resource lookup that throws', state.throwOnResource],
    ])('falls back to the encryption key when the dedicated secret has %s', (_label, throwing) => {
      const encryptionKey = hex();
      configure({ SECRET_ENCRYPTION_KEY: encryptionKey });
      throwing.add('HMAC_SIGNING_SECRET');
      throwing.add('HMAC_SIGNING_SECRET_PREVIOUS');
      expect(signingKey('search-image-url')).toBe(derived(encryptionKey, 'search-image-url'));
      expect(verificationKeys('search-image-url')).toEqual([derived(encryptionKey, 'search-image-url'), encryptionKey]);
    });

    it.each([
      ['a getter that throws', state.throwOnValue],
      ['a resource lookup that throws', state.throwOnResource],
    ])('degrades to nothing when every secret has %s', (_label, throwing) => {
      for (const name of ['HMAC_SIGNING_SECRET', 'HMAC_SIGNING_SECRET_PREVIOUS', 'SECRET_ENCRYPTION_KEY']) {
        throwing.add(name);
      }
      expect(signingKey('purge-receipt')).toBe('');
      expect(verificationKeys('purge-receipt')).toEqual([]);
    });

    it('keeps the dedicated key when only the previous slot is unlinked', () => {
      const root = hex();
      configure({ HMAC_SIGNING_SECRET: root });
      state.throwOnValue.add('HMAC_SIGNING_SECRET_PREVIOUS');
      expect(verificationKeys('purge-receipt')).toEqual([derived(root, 'purge-receipt')]);
    });
  });

  it('reads the secrets on each call, so a later change is picked up', () => {
    const first = hex();
    configure({ SECRET_ENCRYPTION_KEY: first });
    expect(signingKey('purge-receipt')).toBe(derived(first, 'purge-receipt'));
    const root = hex();
    configure({ HMAC_SIGNING_SECRET: root });
    expect(signingKey('purge-receipt')).toBe(derived(root, 'purge-receipt'));
  });
});
