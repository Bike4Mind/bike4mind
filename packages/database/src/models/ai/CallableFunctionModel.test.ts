import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import {
  CALLABLE_FUNCTION_LIMITS,
  CallableFunctionCapError,
  CallableFunctionProtectedFieldError,
  CallableFunctionSlugConflictError,
  calculateContentHash,
  parseFunctionContract,
  type CallableFunctionCreateInput,
  type CallableFunctionOwner,
  type FunctionContract,
  type ICallableFunctionDataPin,
} from '@bike4mind/common';
import { createMongoServer } from '../../__test__/createMongoServer';
import { CallableFunction, CallableFunctionOwnerError, callableFunctionRepository } from './CallableFunctionModel';

const SOURCE = 'FUNCTION = {}\n\ndef run(span):\n    return {"deflection": span}\n';

// Every keyword the contract subset allows, and an empty object.
const RAW_CONTRACT = {
  name: 'beam_midspan_deflection',
  description: 'Midspan deflection of a simply supported beam.',
  inputs: {
    type: 'object',
    additionalProperties: false,
    required: ['span', 'material'],
    properties: {
      span: { type: 'number', unit: 'm', exclusiveMinimum: 0, maximum: 100, default: 5, description: 'Clear span' },
      material: { type: 'string', enum: ['steel', 'timber'], maxLength: 20 },
      count: { type: 'integer', unit: '1', minimum: 1, enum: [1, 2, 3] },
      braced: { type: 'boolean', default: false },
      loads: { type: 'array', minItems: 0, maxItems: 4, items: { type: 'number', unit: 'N/m' } },
      options: { type: 'object', additionalProperties: false, properties: {} },
    },
  },
  outputs: {
    type: 'object',
    additionalProperties: false,
    required: ['deflection'],
    properties: { deflection: { type: 'number', unit: 'm' } },
  },
};

function parsedContract(): FunctionContract {
  const parsed = parseFunctionContract(structuredClone(RAW_CONTRACT));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
  return parsed.contract;
}

const OWNER: CallableFunctionOwner = { ownerType: 'user', ownerKey: 'user-1' };
const OTHER: CallableFunctionOwner = { ownerType: 'user', ownerKey: 'user-2' };

const fn = (overrides: Partial<CallableFunctionCreateInput> = {}): CallableFunctionCreateInput => ({
  ownerType: 'user',
  ownerKey: 'user-1',
  userId: 'user-1',
  slug: 'beam_midspan_deflection',
  description: RAW_CONTRACT.description,
  enabled: true,
  pin: {
    artifactId: 'artifact-1',
    version: 1,
    contentHash: calculateContentHash(SOURCE),
    source: SOURCE,
    pinnedAt: new Date(),
  },
  contract: parsedContract(),
  ...overrides,
});

const DATA_PIN: ICallableFunctionDataPin = {
  name: 'points.csv',
  sha256: 'a'.repeat(64),
  bytes: 12,
  sourceFileId: 'file-1',
  pinnedAt: new Date(),
};

describe('CallableFunctionModel', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await createMongoServer();
    await mongoose.connect(mongoServer.getUri());
    await CallableFunction.init();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer?.stop();
  });

  afterEach(async () => {
    await CallableFunction.deleteMany({});
  });

  describe('indexes', () => {
    it('declares the unique name index, the three grant indexes and no index on the artifact', async () => {
      const byName = new Map((await CallableFunction.collection.indexes()).map(index => [index.name, index]));
      expect(byName.get('callablefn_owner_slug')).toMatchObject({
        key: { ownerType: 1, ownerKey: 1, slug: 1 },
        unique: true,
      });
      expect([...byName.keys()].sort()).toEqual([
        '_id_',
        'callablefn_grant_org_state',
        'callablefn_grant_project',
        'callablefn_grant_users',
        'callablefn_owner_slug',
      ]);
    });

    it('refuses a second function with the same slug for one owner', async () => {
      await callableFunctionRepository.create(fn());
      await expect(
        callableFunctionRepository.create(fn({ pin: { ...fn().pin, artifactId: 'artifact-2' } }))
      ).rejects.toThrow(CallableFunctionSlugConflictError);
    });

    it('allows the same slug and artifact for another owner', async () => {
      await callableFunctionRepository.create(fn());
      await callableFunctionRepository.create(fn({ ownerKey: 'user-2', userId: 'user-2' }));
      expect(await CallableFunction.countDocuments({ slug: 'beam_midspan_deflection' })).toBe(2);
    });

    it('allows a second function from the same artifact under another name', async () => {
      await callableFunctionRepository.create(fn());
      await callableFunctionRepository.create(fn({ slug: 'other_name' }));
      expect(await CallableFunction.countDocuments({ 'pin.artifactId': fn().pin.artifactId })).toBe(2);
    });
  });

  describe('schema bounds', () => {
    it('refuses ownerKey different from userId, on create and on a direct save', async () => {
      await expect(callableFunctionRepository.create(fn({ ownerKey: 'user-2' }))).rejects.toThrow(
        CallableFunctionOwnerError
      );
      await expect(new CallableFunction(fn({ userId: 'user-2' })).save()).rejects.toThrow(CallableFunctionOwnerError);
      expect(await CallableFunction.countDocuments({})).toBe(0);
    });

    it('refuses a hash that is not 64 lowercase hex characters', async () => {
      const pin = fn().pin;
      await expect(
        callableFunctionRepository.create(fn({ pin: { ...pin, contentHash: 'a'.repeat(63) } }))
      ).rejects.toThrow(/contentHash/);
      await expect(
        callableFunctionRepository.create(fn({ pin: { ...pin, contentHash: 'A'.repeat(64) } }))
      ).rejects.toThrow(/contentHash/);
    });

    it('takes pinned code of exactly the byte limit and refuses one byte more', async () => {
      const atLimit = 'x'.repeat(CALLABLE_FUNCTION_LIMITS.maxSourceBytes);
      await expect(
        callableFunctionRepository.create(fn({ pin: { ...fn().pin, source: atLimit } }))
      ).resolves.toMatchObject({ slug: 'beam_midspan_deflection' });
      await CallableFunction.deleteMany({});
      await expect(
        callableFunctionRepository.create(fn({ pin: { ...fn().pin, source: `${atLimit}x` } }))
      ).rejects.toThrow(/over 262144 bytes/);
      // Counted in UTF-8 bytes, not characters: this two-byte character is under the limit in characters.
      const multibyte = String.fromCharCode(0xe9).repeat(CALLABLE_FUNCTION_LIMITS.maxSourceBytes / 2 + 1);
      await expect(callableFunctionRepository.create(fn({ pin: { ...fn().pin, source: multibyte } }))).rejects.toThrow(
        /over 262144 bytes/
      );
    });

    it('takes a description of 1 to 500 characters', async () => {
      await expect(callableFunctionRepository.create(fn({ description: '' }))).rejects.toThrow(/description/);
      await expect(callableFunctionRepository.create(fn({ description: 'x'.repeat(501) }))).rejects.toThrow(
        /description/
      );
      await expect(callableFunctionRepository.create(fn({ description: 'x'.repeat(500) }))).resolves.toMatchObject({
        slug: 'beam_midspan_deflection',
      });
    });

    it('refuses a slug outside the rule and a version below 1', async () => {
      await expect(callableFunctionRepository.create(fn({ slug: 'a__b' }))).rejects.toThrow(/slug/);
      await expect(callableFunctionRepository.create(fn({ slug: 'trailing_' }))).rejects.toThrow(/slug/);
      await expect(callableFunctionRepository.create(fn({ pin: { ...fn().pin, version: 0 } }))).rejects.toThrow(
        /version/
      );
      await expect(callableFunctionRepository.create(fn({ pin: { ...fn().pin, version: 1.5 } }))).rejects.toThrow(
        /whole number/
      );
    });

    it('stores the contract and reads it back unchanged', async () => {
      const contract = parsedContract();
      const created = await callableFunctionRepository.create(fn({ contract }));
      const read = await callableFunctionRepository.findByIdForOwner(created.id, OWNER);
      expect(read?.contract).toEqual(contract);
      expect(read?.contract).toEqual(RAW_CONTRACT);
      expect(read?.contract.inputs.properties.options).toEqual({
        type: 'object',
        additionalProperties: false,
        properties: {},
      });
      expect(read?.pin.source).toBe(SOURCE);
    });
  });

  describe('generic writers', () => {
    it.each(['pin', 'pin.version', 'state', 'slug', 'ownerKey', 'userId', 'contract', 'description'])(
      'update refuses %s',
      async field => {
        const created = await callableFunctionRepository.create(fn());
        await expect(
          callableFunctionRepository.update({ id: created.id, [field]: 'x' } as never)
        ).rejects.toBeInstanceOf(CallableFunctionProtectedFieldError);
      }
    );

    it('updateGuarded, updateMany, and an unset of a protected field are refused too', async () => {
      const created = await callableFunctionRepository.create(fn());
      await expect(
        callableFunctionRepository.updateGuarded({ id: created.id, state: 'live' } as never)
      ).rejects.toBeInstanceOf(CallableFunctionProtectedFieldError);
      await expect(callableFunctionRepository.updateMany({}, { slug: 'other' } as never)).rejects.toBeInstanceOf(
        CallableFunctionProtectedFieldError
      );
      await expect(
        callableFunctionRepository.update({ id: created.id, enabled: false } as never, { unset: ['pin'] } as never)
      ).rejects.toBeInstanceOf(CallableFunctionProtectedFieldError);
      expect((await CallableFunction.findById(created.id).lean())?.state).toBe('draft');
    });

    it('lets a generic write turn a function off', async () => {
      const created = await callableFunctionRepository.create(fn());
      await callableFunctionRepository.update({ id: created.id, enabled: false } as never);
      expect((await callableFunctionRepository.findByIdForOwner(created.id, OWNER))?.enabled).toBe(false);
    });
  });

  describe('owner-scoped reads and writes', () => {
    it('findByIdForOwner is null for another owner and for an id that is not an ObjectId', async () => {
      const created = await callableFunctionRepository.create(fn());
      expect(await callableFunctionRepository.findByIdForOwner(created.id, OWNER)).toMatchObject({ id: created.id });
      expect(await callableFunctionRepository.findByIdForOwner(created.id, OTHER)).toBeNull();
      expect(await callableFunctionRepository.findByIdForOwner('not-an-id', OWNER)).toBeNull();
    });

    it("findBySlugForOwner reads only the owner's function, without the contract or the pinned code", async () => {
      const created = await callableFunctionRepository.create(fn());
      const found = await callableFunctionRepository.findBySlugForOwner('beam_midspan_deflection', OWNER);
      expect(found).toMatchObject({ id: created.id, pin: { artifactId: created.pin.artifactId } });
      expect(found).not.toHaveProperty('contract');
      expect(found?.pin).not.toHaveProperty('source');
      expect(await callableFunctionRepository.findBySlugForOwner('beam_midspan_deflection', OTHER)).toBeNull();
      expect(await callableFunctionRepository.findBySlugForOwner('other_name', OWNER)).toBeNull();
    });

    it('setEnabled writes only for the owner', async () => {
      const created = await callableFunctionRepository.create(fn());
      expect(await callableFunctionRepository.setEnabled(created.id, OTHER, false)).toBeNull();
      expect(await callableFunctionRepository.setEnabled('not-an-id', OWNER, false)).toBeNull();
      expect(await callableFunctionRepository.setEnabled(created.id, OWNER, false)).toMatchObject({ enabled: false });
    });

    it('deleteForOwner is false for another owner and true once for the owner', async () => {
      const created = await callableFunctionRepository.create(fn());
      expect(await callableFunctionRepository.deleteForOwner(created.id, OTHER)).toBe(false);
      expect(await callableFunctionRepository.deleteForOwner('not-an-id', OWNER)).toBe(false);
      expect(await callableFunctionRepository.deleteForOwner(created.id, OWNER)).toBe(true);
      expect(await callableFunctionRepository.deleteForOwner(created.id, OWNER)).toBe(false);
    });

    it("lists only the owner's functions, oldest first, without the contract or the pinned code", async () => {
      const first = await callableFunctionRepository.create(fn());
      const second = await callableFunctionRepository.create(
        fn({ slug: 'second_fn', pin: { ...fn().pin, artifactId: 'artifact-2' } })
      );
      await callableFunctionRepository.create(fn({ ownerKey: 'user-2', userId: 'user-2' }));

      const listed = await callableFunctionRepository.listForOwner(OWNER);
      expect(listed.map(item => item.id)).toEqual([first.id, second.id]);
      for (const item of listed) {
        expect(item).not.toHaveProperty('contract');
        expect(item.pin).not.toHaveProperty('source');
        expect(item.pin.contentHash).toBe(calculateContentHash(SOURCE));
      }
      expect(
        (await callableFunctionRepository.listForOwner(OWNER, { artifactId: 'artifact-2' })).map(item => item.id)
      ).toEqual([second.id]);
      expect(await callableFunctionRepository.listForOwner({ ownerType: 'user', ownerKey: 'user-3' })).toEqual([]);
    });
  });

  describe('repin', () => {
    const nextPin = () => ({
      artifactId: 'artifact-1',
      version: 2,
      contentHash: calculateContentHash(`${SOURCE}# v2\n`),
      source: `${SOURCE}# v2\n`,
      pinnedAt: new Date(),
    });

    it('moves the pin, contract, and description together when the expected version matches', async () => {
      const created = await callableFunctionRepository.create(fn());
      const contract = { ...parsedContract(), description: 'Updated description.' };
      const repinned = await callableFunctionRepository.repin(created.id, OWNER, 1, {
        pin: nextPin(),
        contract,
        description: contract.description,
      });
      expect(repinned).toMatchObject({ description: 'Updated description.', pin: { version: 2 } });
      expect(repinned?.pin.source).toBe(`${SOURCE}# v2\n`);
      expect(repinned?.contract.description).toBe('Updated description.');
    });

    it('is null when stale, for another owner, or for a malformed id, and writes nothing', async () => {
      const created = await callableFunctionRepository.create(fn());
      const update = { pin: nextPin(), contract: parsedContract(), description: RAW_CONTRACT.description };
      expect(await callableFunctionRepository.repin(created.id, OWNER, 2, update)).toBeNull();
      expect(await callableFunctionRepository.repin(created.id, OTHER, 1, update)).toBeNull();
      expect(await callableFunctionRepository.repin('not-an-id', OWNER, 1, update)).toBeNull();
      expect((await callableFunctionRepository.findByIdForOwner(created.id, OWNER))?.pin.version).toBe(1);
    });

    it('runs the pin validators on the update', async () => {
      const created = await callableFunctionRepository.create(fn());
      await expect(
        callableFunctionRepository.repin(created.id, OWNER, 1, {
          pin: { ...nextPin(), contentHash: 'not-a-hash' },
          contract: parsedContract(),
          description: RAW_CONTRACT.description,
        })
      ).rejects.toThrow(/contentHash/);
    });

    it('keeps the data pins', async () => {
      const created = await callableFunctionRepository.create(fn());
      const pinned = await callableFunctionRepository.setDataPins(created.id, OWNER, { updatedAt: created.updatedAt }, [
        DATA_PIN,
      ]);
      expect(pinned?.pin.dataPins).toHaveLength(1);
      const repinned = await callableFunctionRepository.repin(created.id, OWNER, 1, {
        pin: nextPin(),
        contract: parsedContract(),
        description: RAW_CONTRACT.description,
      });
      expect(repinned?.pin.version).toBe(2);
      expect(repinned?.pin.dataPins).toMatchObject([{ name: 'points.csv', sha256: DATA_PIN.sha256, bytes: 12 }]);
    });
  });

  describe('setSources', () => {
    it('returns a live function to draft and drops the frozen source pins', async () => {
      const created = await callableFunctionRepository.create(fn());
      const sourcePin = { name: 'base.csv', sha256: 'b'.repeat(64), bytes: 8, fetchedAt: new Date(0) };
      const live = await callableFunctionRepository.promote(
        created.id,
        OWNER,
        { updatedAt: created.updatedAt },
        {
          seq: 1,
          runtime: { kind: 'pyodide-server', version: '0.25.1', packages: [] },
          lastServerRun: { at: new Date(), passed: 1, failed: 0, results: [] },
          trustLabel: 'verified',
          contract: created.contract,
          pin: created.pin,
          description: created.description,
          sourcePins: [sourcePin],
        }
      );
      expect(live).toMatchObject({ state: 'live', pin: { sourcePins: [{ name: 'base.csv' }] } });
      const updated = await callableFunctionRepository.setSources(created.id, OWNER, { updatedAt: live!.updatedAt }, [
        { name: 'base.csv', url: 'https://data.example.com/base.csv', mode: 'pinned' },
      ]);
      expect(updated?.state).toBe('draft');
      expect(updated?.pin.sourcePins).toBeUndefined();
      expect(updated?.trustLabel).toBeUndefined();
    });
  });

  describe('platform mark', () => {
    type Saved = Awaited<ReturnType<typeof callableFunctionRepository.create>>;
    const promoteAs = async (saved: Saved, trustLabel: 'verified' | 'unverified', seq = 1): Promise<Saved> => {
      const promoted = await callableFunctionRepository.promote(
        saved.id,
        OWNER,
        { updatedAt: saved.updatedAt },
        {
          seq,
          runtime: { kind: 'pyodide-server', version: '0.25.1', packages: [] },
          lastServerRun: { at: new Date(), passed: 1, failed: 0, results: [] },
          trustLabel,
          contract: saved.contract,
          pin: saved.pin,
          description: saved.description,
          sourcePins: [],
        }
      );
      if (!promoted) throw new Error('promotion did not land');
      return promoted;
    };
    const mark = { setBy: 'admin-1', setAt: new Date('2026-01-03T00:00:00Z') };

    it('marks only a live, verified function and records who set it', async () => {
      const created = await callableFunctionRepository.create(fn());
      expect(await callableFunctionRepository.setPlatformMark(created.id, mark)).toBeNull();
      const unverified = await promoteAs(created, 'unverified');
      expect(await callableFunctionRepository.setPlatformMark(created.id, mark)).toBeNull();
      await promoteAs(unverified, 'verified', 2);
      const marked = await callableFunctionRepository.setPlatformMark(created.id, mark);
      expect(marked?.platform).toEqual(mark);
      expect(marked?.trustLabel).toBe('verified');
      expect(await callableFunctionRepository.setPlatformMark('not-an-id', mark)).toBeNull();
    });

    it('is cleared only by its own writer, and a generic update refuses it', async () => {
      const created = await callableFunctionRepository.create(fn());
      await promoteAs(created, 'verified');
      await callableFunctionRepository.setPlatformMark(created.id, mark);
      await expect(
        callableFunctionRepository.update({ id: created.id, enabled: true } as never, { unset: ['platform'] } as never)
      ).rejects.toBeInstanceOf(CallableFunctionProtectedFieldError);
      await expect(
        callableFunctionRepository.update({ id: created.id, platform: mark } as never)
      ).rejects.toBeInstanceOf(CallableFunctionProtectedFieldError);
      expect((await callableFunctionRepository.clearPlatformMark(created.id))?.platform).toBeUndefined();
      expect(await callableFunctionRepository.clearPlatformMark(created.id)).toBeNull();
    });

    it('survives a verified promotion and is dropped by an unverified one', async () => {
      const created = await callableFunctionRepository.create(fn());
      await promoteAs(created, 'verified');
      const marked = (await callableFunctionRepository.setPlatformMark(created.id, mark))!;
      const again = await promoteAs(marked, 'verified', 2);
      expect(again.platform).toEqual(mark);
      const dropped = await promoteAs(again, 'unverified', 3);
      expect(dropped.platform).toBeUndefined();
      expect(dropped.trustLabel).toBe('unverified');
    });

    it('is dropped when an examples edit unverifies the function', async () => {
      const created = await callableFunctionRepository.create(fn());
      await promoteAs(created, 'verified');
      const marked = (await callableFunctionRepository.setPlatformMark(created.id, mark))!;
      const edited = await callableFunctionRepository.setExamples(
        created.id,
        OWNER,
        { updatedAt: marked.updatedAt },
        [],
        { unverify: true }
      );
      expect(edited?.trustLabel).toBe('unverified');
      expect(edited?.platform).toBeUndefined();
    });

    it('is dropped by a code, data, or source edit, and a verified re-promotion does not bring it back', async () => {
      const created = await callableFunctionRepository.create(fn());
      const live = await promoteAs(created, 'verified');
      await callableFunctionRepository.setPlatformMark(created.id, mark);
      const repinned = await callableFunctionRepository.repin(created.id, OWNER, 1, {
        pin: {
          artifactId: 'artifact-1',
          version: 2,
          contentHash: calculateContentHash(`${SOURCE}# v2\n`),
          source: `${SOURCE}# v2\n`,
          pinnedAt: new Date(),
        },
        contract: live.contract,
        description: live.description,
      });
      expect(repinned?.state).toBe('draft');
      expect(repinned?.platform).toBeUndefined();
      const relive = await promoteAs(repinned!, 'verified', 2);
      expect(relive.platform).toBeUndefined();

      const remarked = (await callableFunctionRepository.setPlatformMark(created.id, mark))!;
      const pinned = await callableFunctionRepository.setDataPins(
        created.id,
        OWNER,
        { updatedAt: remarked.updatedAt },
        [DATA_PIN]
      );
      expect(pinned?.platform).toBeUndefined();

      await promoteAs(pinned!, 'verified', 3);
      const marked = (await callableFunctionRepository.setPlatformMark(created.id, mark))!;
      expect(marked.platform).toEqual(mark);
      const resourced = await callableFunctionRepository.setSources(
        created.id,
        OWNER,
        { updatedAt: marked.updatedAt },
        [{ name: 'base.csv', url: 'https://data.example.com/base.csv', mode: 'pinned' }]
      );
      expect(resourced?.state).toBe('draft');
      expect(resourced?.platform).toBeUndefined();
    });
  });

  describe('setDataPins', () => {
    it('returns a live function to draft and drops its promoted runtime and label', async () => {
      const created = await callableFunctionRepository.create(fn());
      const live = await callableFunctionRepository.promote(
        created.id,
        OWNER,
        { updatedAt: created.updatedAt },
        {
          seq: 1,
          runtime: { kind: 'pyodide-server', version: '0.25.1', packages: [] },
          lastServerRun: { at: new Date(), passed: 1, failed: 0, results: [] },
          trustLabel: 'verified',
          contract: created.contract,
          pin: created.pin,
          description: created.description,
        }
      );
      expect(live).toMatchObject({ state: 'live', trustLabel: 'verified', pin: { seq: 1 } });
      const pinned = await callableFunctionRepository.setDataPins(created.id, OWNER, { updatedAt: live!.updatedAt }, [
        DATA_PIN,
      ]);
      expect(pinned?.state).toBe('draft');
      expect(pinned?.trustLabel).toBeUndefined();
      expect(pinned?.lastServerRun).toBeUndefined();
      expect(pinned?.pin.seq).toBeUndefined();
      expect(pinned?.pin.runtime).toBeUndefined();
      expect(pinned?.pin.dataPins).toHaveLength(1);
    });

    it('is null when stale or for another owner, and writes nothing', async () => {
      const created = await callableFunctionRepository.create(fn());
      const expected = { updatedAt: created.updatedAt };
      expect(await callableFunctionRepository.setDataPins(created.id, OTHER, expected, [DATA_PIN])).toBeNull();
      expect(
        await callableFunctionRepository.setDataPins(created.id, OWNER, { updatedAt: new Date(0) }, [DATA_PIN])
      ).toBeNull();
      expect((await callableFunctionRepository.findByIdForOwner(created.id, OWNER))?.pin.dataPins ?? []).toEqual([]);
    });
  });

  describe('per-owner cap', () => {
    const numbered = (n: number, owner = 'user-1') =>
      fn({ ownerKey: owner, userId: owner, slug: `fn_${n}`, pin: { ...fn().pin, artifactId: `artifact-${n}` } });

    it('refuses the create that would pass the cap and leaves the count at the cap', async () => {
      await callableFunctionRepository.createWithinOwnerCap(numbered(1), 2);
      await callableFunctionRepository.createWithinOwnerCap(numbered(2), 2);
      const third = callableFunctionRepository.createWithinOwnerCap(numbered(3), 2);
      await expect(third).rejects.toThrow(CallableFunctionCapError);
      await expect(third).rejects.toMatchObject({ additionalInfo: { code: 'function_limit', limit: 2 } });
      expect(await callableFunctionRepository.countForOwner(OWNER)).toBe(2);
    });

    it('counts per owner', async () => {
      await callableFunctionRepository.createWithinOwnerCap(numbered(1), 1);
      await expect(callableFunctionRepository.createWithinOwnerCap(numbered(1, 'user-2'), 1)).resolves.toMatchObject({
        userId: 'user-2',
      });
    });

    it('never passes the cap under concurrent creates', async () => {
      await callableFunctionRepository.createWithinOwnerCap(numbered(1), 3);
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) => callableFunctionRepository.createWithinOwnerCap(numbered(10 + i), 3))
      );
      for (const result of results.filter(r => r.status === 'rejected')) {
        expect((result as PromiseRejectedResult).reason).toBeInstanceOf(CallableFunctionCapError);
      }
      expect(await callableFunctionRepository.countForOwner(OWNER)).toBeLessThanOrEqual(3);
    });
  });
});
