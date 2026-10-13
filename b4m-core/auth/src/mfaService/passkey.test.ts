import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'crypto';
import { isoBase64URL, isoCBOR } from '@simplewebauthn/server/helpers';
import type {
  IPasskeyChallengeRepository,
  IPasskeyCredential,
  IPasskeyCredentialRepository,
  IUserDocument,
  PasskeyChallengePurpose,
} from '@bike4mind/common';
import {
  MAX_PASSKEYS_PER_USER,
  finishPasskeyAuthentication,
  finishPasskeyRegistration,
  resolvePasskeyRelyingParty,
  startPasskeyAuthentication,
  startPasskeyRegistration,
  type AuthenticationResponseJSON,
  type PasskeyDeps,
  type RegistrationResponseJSON,
} from './passkey';

const RP = resolvePasskeyRelyingParty('https://app.example.com', 'Example');
const PHISHING_ORIGIN = 'https://app-example.login.evil.test';

const b64 = (bytes: Uint8Array | string) =>
  isoBase64URL.fromBuffer(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes);
const sha256 = (data: Uint8Array | string) => new Uint8Array(createHash('sha256').update(data).digest());

/** A minimal ES256 platform authenticator, so the ceremonies run through real signature checks. */
class SoftAuthenticator {
  readonly credentialId = new Uint8Array(randomBytes(16));
  counter = 0;
  private readonly keys: { publicKey: KeyObject; privateKey: KeyObject };

  constructor() {
    this.keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  }

  get id(): string {
    return b64(this.credentialId);
  }

  private cosePublicKey(): Uint8Array {
    const jwk = this.keys.publicKey.export({ format: 'jwk' });
    return isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, isoBase64URL.toBuffer(jwk.x!)],
        [-3, isoBase64URL.toBuffer(jwk.y!)],
      ])
    );
  }

  private authData(rpID: string, flags: number, attested: boolean): Uint8Array {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const parts: Uint8Array[] = [sha256(rpID), Uint8Array.of(flags), counter];
    if (attested) {
      const idLength = Buffer.alloc(2);
      idLength.writeUInt16BE(this.credentialId.length);
      parts.push(new Uint8Array(16), idLength, this.credentialId, this.cosePublicKey());
    }
    return Buffer.concat(parts);
  }

  register(challenge: string, origin = RP.origin, rpID = RP.rpID): RegistrationResponseJSON {
    const clientDataJSON = JSON.stringify({ type: 'webauthn.create', challenge, origin, crossOrigin: false });
    // UP | UV | AT
    const authData = this.authData(rpID, 0x45, true);
    const attestationObject = isoCBOR.encode(
      new Map<string, string | Uint8Array | Map<string, never>>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ])
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64(clientDataJSON),
        attestationObject: b64(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults: {},
    };
  }

  authenticate(challenge: string, origin = RP.origin): AuthenticationResponseJSON {
    this.counter += 1;
    const clientDataJSON = JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false });
    // UP | UV
    const authenticatorData = this.authData(RP.rpID, 0x05, false);
    const signature = sign('sha256', Buffer.concat([authenticatorData, sha256(clientDataJSON)]), this.keys.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64(clientDataJSON),
        authenticatorData: b64(authenticatorData),
        signature: b64(new Uint8Array(signature)),
      },
      clientExtensionResults: {},
    };
  }
}

class MemoryCredentials implements IPasskeyCredentialRepository {
  rows: IPasskeyCredential[] = [];
  async create(input: Omit<IPasskeyCredential, 'id' | 'createdAt' | 'lastUsedAt'>) {
    if (this.rows.some(r => r.credentialId === input.credentialId))
      throw Object.assign(new Error('dup'), { code: 11000 });
    const row = { ...input, id: `cred-${this.rows.length + 1}`, createdAt: new Date() };
    this.rows.push(row);
    return row;
  }
  async listByUser(userId: string) {
    return this.rows.filter(r => r.userId === userId);
  }
  async countByUser(userId: string) {
    return this.rows.filter(r => r.userId === userId).length;
  }
  async findByCredentialId(userId: string, credentialId: string) {
    return this.rows.find(r => r.userId === userId && r.credentialId === credentialId) ?? null;
  }
  async recordUse(id: string, counter: number) {
    const row = this.rows.find(r => r.id === id)!;
    row.counter = counter;
    row.lastUsedAt = new Date();
  }
  async remove(id: string, userId: string) {
    const before = this.rows.length;
    this.rows = this.rows.filter(r => !(r.id === id && r.userId === userId));
    return this.rows.length < before;
  }
  async removeAllForUser(userId: string) {
    const before = this.rows.length;
    this.rows = this.rows.filter(r => r.userId !== userId);
    return before - this.rows.length;
  }
}

class MemoryChallenges implements IPasskeyChallengeRepository {
  store = new Map<string, string>();
  async issue(userId: string, purpose: PasskeyChallengePurpose, challenge: string) {
    this.store.set(`${userId}:${purpose}`, challenge);
  }
  async consume(userId: string, purpose: PasskeyChallengePurpose) {
    const key = `${userId}:${purpose}`;
    const challenge = this.store.get(key) ?? null;
    this.store.delete(key);
    return challenge;
  }
}

const makeUser = (id = 'user-1', mfa: Record<string, unknown> | null = {}): IUserDocument =>
  ({
    id,
    email: `${id}@example.com`,
    username: id,
    name: 'Test User',
    mfa:
      mfa === null
        ? null
        : { totpEnabled: true, totpSecret: 'SECRET', backupCodes: ['hash'], setupAt: new Date(), ...mfa },
  }) as unknown as IUserDocument;

let deps: PasskeyDeps & { credentials: MemoryCredentials; challenges: MemoryChallenges };
const users = { update: vi.fn(async (u: unknown) => u as IUserDocument) };

beforeEach(() => {
  deps = { credentials: new MemoryCredentials(), challenges: new MemoryChallenges() };
  users.update.mockClear();
});

async function enroll(user: IUserDocument, authenticator = new SoftAuthenticator()) {
  const options = await startPasskeyRegistration({ user, rp: RP }, deps);
  await finishPasskeyRegistration(
    { user, rp: RP, response: authenticator.register(options.challenge), name: 'Laptop' },
    deps
  );
  return authenticator;
}

describe('resolvePasskeyRelyingParty', () => {
  it('pins the RP id and origin to the configured app URL', () => {
    expect(resolvePasskeyRelyingParty('https://app.example.com/some/path', '')).toEqual({
      rpID: 'app.example.com',
      rpName: 'app.example.com',
      origin: 'https://app.example.com',
    });
  });

  it('fails closed without an app URL', () => {
    expect(() => resolvePasskeyRelyingParty(undefined, 'x')).toThrow(/APP_URL/);
  });
});

describe('passkey registration ceremony', () => {
  it('verifies the attestation and stores the credential', async () => {
    const user = makeUser();
    const authenticator = new SoftAuthenticator();
    const options = await startPasskeyRegistration({ user, rp: RP }, deps);

    expect(options.rp.id).toBe(RP.rpID);
    expect(options.attestation).toBe('none');

    const created = await finishPasskeyRegistration(
      { user, rp: RP, response: authenticator.register(options.challenge), name: '  Laptop  ' },
      deps
    );

    expect(created).toMatchObject({
      userId: 'user-1',
      credentialId: authenticator.id,
      counter: 0,
      name: 'Laptop',
      transports: ['internal'],
    });
    expect(deps.credentials.rows).toHaveLength(1);
  });

  it('excludes already-registered credentials from new registration options', async () => {
    const user = makeUser();
    const authenticator = await enroll(user);
    const options = await startPasskeyRegistration({ user, rp: RP }, deps);
    expect(options.excludeCredentials?.map(c => c.id)).toEqual([authenticator.id]);
  });

  it('requires authenticator-app MFA to be on before enrolling', async () => {
    await expect(startPasskeyRegistration({ user: makeUser('u', null), rp: RP }, deps)).rejects.toMatchObject({
      code: 'mfa_not_enabled',
    });
  });

  it('rejects an attestation produced for another origin', async () => {
    const user = makeUser();
    const options = await startPasskeyRegistration({ user, rp: RP }, deps);
    await expect(
      finishPasskeyRegistration(
        { user, rp: RP, response: new SoftAuthenticator().register(options.challenge, PHISHING_ORIGIN) },
        deps
      )
    ).rejects.toMatchObject({ code: 'verification_failed' });
    expect(deps.credentials.rows).toHaveLength(0);
  });

  it('consumes the challenge, so a response cannot be submitted twice', async () => {
    const user = makeUser();
    const options = await startPasskeyRegistration({ user, rp: RP }, deps);
    const response = new SoftAuthenticator().register(options.challenge);
    await finishPasskeyRegistration({ user, rp: RP, response }, deps);
    await expect(finishPasskeyRegistration({ user, rp: RP, response }, deps)).rejects.toMatchObject({
      code: 'challenge_expired',
    });
  });

  it('rejects a response signed over a stale challenge', async () => {
    const user = makeUser();
    const stale = await startPasskeyRegistration({ user, rp: RP }, deps);
    await startPasskeyRegistration({ user, rp: RP }, deps);
    await expect(
      finishPasskeyRegistration({ user, rp: RP, response: new SoftAuthenticator().register(stale.challenge) }, deps)
    ).rejects.toMatchObject({ code: 'verification_failed' });
  });

  it('caps the number of passkeys per user', async () => {
    const user = makeUser();
    for (let i = 0; i < MAX_PASSKEYS_PER_USER; i++) await enroll(user);
    await expect(startPasskeyRegistration({ user, rp: RP }, deps)).rejects.toMatchObject({ code: 'limit_reached' });
  });
});

describe('passkey authentication ceremony', () => {
  it('verifies the assertion, advances the counter and clears the MFA lockout', async () => {
    const user = makeUser('user-1', { failedAttempts: 2, lockedUntil: new Date(Date.now() + 60_000) });
    const authenticator = await enroll(user);

    const options = await startPasskeyAuthentication({ userId: user.id, rp: RP }, deps);
    expect(options.allowCredentials?.map(c => c.id)).toEqual([authenticator.id]);

    const result = await finishPasskeyAuthentication(
      { user, rp: RP, response: authenticator.authenticate(options.challenge) },
      { ...deps, users }
    );

    expect(result.credentialId).toBe(deps.credentials.rows[0].id);
    expect(deps.credentials.rows[0].counter).toBe(1);
    const written = users.update.mock.calls[0][0] as { mfa: Record<string, unknown> };
    expect(written.mfa).toMatchObject({ failedAttempts: 0, lockedUntil: undefined, totpSecret: 'SECRET' });
    expect(written.mfa.lastUsedAt).toBeInstanceOf(Date);
  });

  it('refuses to start when the user has no passkeys', async () => {
    await expect(startPasskeyAuthentication({ userId: 'user-1', rp: RP }, deps)).rejects.toMatchObject({
      code: 'no_passkeys',
    });
  });

  it('rejects an assertion relayed through a phishing origin', async () => {
    const user = makeUser();
    const authenticator = await enroll(user);
    const options = await startPasskeyAuthentication({ userId: user.id, rp: RP }, deps);
    await expect(
      finishPasskeyAuthentication(
        { user, rp: RP, response: authenticator.authenticate(options.challenge, PHISHING_ORIGIN) },
        { ...deps, users }
      )
    ).rejects.toMatchObject({ code: 'verification_failed' });
    expect(users.update).not.toHaveBeenCalled();
  });

  it('rejects a replayed assertion', async () => {
    const user = makeUser();
    const authenticator = await enroll(user);
    const options = await startPasskeyAuthentication({ userId: user.id, rp: RP }, deps);
    const response = authenticator.authenticate(options.challenge);
    await finishPasskeyAuthentication({ user, rp: RP, response }, { ...deps, users });

    await startPasskeyAuthentication({ userId: user.id, rp: RP }, deps);
    await expect(finishPasskeyAuthentication({ user, rp: RP, response }, { ...deps, users })).rejects.toMatchObject({
      code: 'verification_failed',
    });
  });

  it('rejects a signature counter that goes backwards (cloned authenticator)', async () => {
    const user = makeUser();
    const authenticator = await enroll(user);
    deps.credentials.rows[0].counter = 50;
    const options = await startPasskeyAuthentication({ userId: user.id, rp: RP }, deps);
    await expect(
      finishPasskeyAuthentication(
        { user, rp: RP, response: authenticator.authenticate(options.challenge) },
        { ...deps, users }
      )
    ).rejects.toMatchObject({ code: 'verification_failed' });
  });

  it("does not accept another account's passkey", async () => {
    const victim = makeUser('victim');
    const attacker = makeUser('attacker');
    await enroll(victim);
    const attackerKey = await enroll(attacker);

    const options = await startPasskeyAuthentication({ userId: victim.id, rp: RP }, deps);
    await expect(
      finishPasskeyAuthentication(
        { user: victim, rp: RP, response: attackerKey.authenticate(options.challenge) },
        { ...deps, users }
      )
    ).rejects.toMatchObject({ code: 'unknown_credential' });
  });

  it('rejects an assertion with no outstanding challenge', async () => {
    const user = makeUser();
    const authenticator = await enroll(user);
    await expect(
      finishPasskeyAuthentication(
        { user, rp: RP, response: authenticator.authenticate('bm90LWlzc3VlZA') },
        { ...deps, users }
      )
    ).rejects.toMatchObject({ code: 'challenge_expired' });
  });

  it('rejects a tampered signature', async () => {
    const user = makeUser();
    const authenticator = await enroll(user);
    const options = await startPasskeyAuthentication({ userId: user.id, rp: RP }, deps);
    const response = authenticator.authenticate(options.challenge);
    const sig = isoBase64URL.toBuffer(response.response.signature);
    sig[sig.length - 1] ^= 0xff;
    response.response.signature = b64(sig);
    await expect(finishPasskeyAuthentication({ user, rp: RP, response }, { ...deps, users })).rejects.toMatchObject({
      code: 'verification_failed',
    });
  });

  it('refuses when MFA has been turned off', async () => {
    const user = makeUser();
    const authenticator = await enroll(user);
    const options = await startPasskeyAuthentication({ userId: user.id, rp: RP }, deps);
    await expect(
      finishPasskeyAuthentication(
        { user: makeUser('user-1', null), rp: RP, response: authenticator.authenticate(options.challenge) },
        { ...deps, users }
      )
    ).rejects.toMatchObject({ code: 'mfa_not_enabled' });
  });
});
