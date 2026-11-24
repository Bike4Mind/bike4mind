import { createHash } from 'crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import {
  CALLABLE_FUNCTION_LIMITS,
  calculateContentHash,
  parseFunctionContract,
  type IArtifactContentRepository,
  type ICallableFunctionDocument,
} from '@bike4mind/common';
import {
  Artifact,
  ArtifactContent,
  CallableFunction,
  CallableFunctionCall,
  artifactContentRepository,
  artifactRepository,
  callableFunctionRepository,
} from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import {
  createCallableFunction,
  deleteCallableFunction,
  getCallableFunction,
  listCallableFunctions,
  repinCallableFunction,
  setCallableFunctionEnabled,
  setCallableFunctionExamples,
  summarizeCallableFunctionCalls,
} from './registry';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const OWNER = { id: 'owner-1' };
const STRANGER = { id: 'stranger-1' };

const code = (extra = '') =>
  `FUNCTION = {"name": "beam_midspan_deflection"}\n\ndef run(load, span):\n    return {"deflection": load * span / 384}\n${extra}`;

const contract = (overrides: Record<string, unknown> = {}) => ({
  name: 'beam_midspan_deflection',
  description: 'Midspan deflection of a simply supported beam under a uniform load.',
  inputs: {
    type: 'object',
    additionalProperties: false,
    required: ['load', 'span'],
    properties: {
      load: { type: 'number', unit: 'N/m', exclusiveMinimum: 0 },
      span: { type: 'number', unit: 'm', exclusiveMinimum: 0, default: 5 },
    },
  },
  outputs: {
    type: 'object',
    additionalProperties: false,
    required: ['deflection'],
    properties: { deflection: { type: 'number', unit: 'm' } },
  },
  ...overrides,
});

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** An artifact at version 1, its content row written the way artifactService.create writes it. */
async function seedArtifact(
  id: string,
  { userId = OWNER.id, type = 'python', content = code(), canWrite = [] as string[] } = {}
): Promise<void> {
  const contentHash = calculateContentHash(content);
  const contentSize = Buffer.byteLength(content, 'utf8');
  const row = await ArtifactContent.create({ artifactId: id, version: 1, content, contentHash, contentSize });
  await Artifact.create({
    id,
    type,
    title: 'Beam deflection',
    version: 1,
    userId,
    permissions: { canRead: [], canWrite, canDelete: [] },
    contentId: row._id,
    contentHash,
    contentSize,
  });
}

// Typed as artifactService.update receives it.
const contentWriter: Pick<IArtifactContentRepository, 'createOrUpdate'> = artifactContentRepository;

/** A new head written the way artifactService.update writes it. */
async function addVersion(id: string, content: string): Promise<number> {
  const artifact = await artifactRepository.findOne({ id });
  const version = artifact!.version + 1;
  await contentWriter.createOrUpdate({
    artifactId: id,
    version,
    content,
    contentHash: calculateContentHash(content),
    contentSize: Buffer.byteLength(content, 'utf8'),
    mimeType: 'text/x-python',
    encoding: 'utf8',
  });
  await artifactRepository.update({ id, version });
  return version;
}

const save = (artifactId = 'artifact-1', overrides: Record<string, unknown> = {}) =>
  createCallableFunction(OWNER, { artifactId, expectedVersion: 1, contract: contract(), ...overrides });

const stored = (id: string) => CallableFunction.findById(id).lean<ICallableFunctionDocument>();

let mongoServer: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([CallableFunction.init(), Artifact.init(), ArtifactContent.init()]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

beforeEach(async () => {
  await seedArtifact('artifact-1');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([CallableFunction.deleteMany({}), Artifact.deleteMany({}), ArtifactContent.deleteMany({})]);
});

describe('createCallableFunction', () => {
  it('pins the head with the sha256 of the stored content and a copy of the code', async () => {
    const view = await save();

    expect(view.pin).toMatchObject({ artifactId: 'artifact-1', version: 1, contentHash: sha256(code()) });
    expect(view).toMatchObject({
      slug: 'beam_midspan_deflection',
      state: 'draft',
      enabled: true,
      status: 'draft',
      latestVersion: 1,
      updateAvailable: false,
    });
    expect(view).not.toHaveProperty('contract');
    expect(view).not.toHaveProperty('ownerKey');
    expect(view.pin).not.toHaveProperty('source');
    const doc = await stored(view.id);
    expect(doc?.pin.source).toBe(code());
    expect(doc).toMatchObject({ ownerType: 'user', ownerKey: OWNER.id, userId: OWNER.id });
  });

  it('pins a head written through the update path', async () => {
    const version = await addVersion('artifact-1', code('# tuned\n'));
    const view = await save('artifact-1', { expectedVersion: version });
    expect(view.pin).toMatchObject({ version: 2, contentHash: sha256(code('# tuned\n')) });
  });

  it('derives the owner, hash, name, and state itself, whatever else the input carries', async () => {
    const view = await createCallableFunction(OWNER, {
      artifactId: 'artifact-1',
      expectedVersion: 1,
      contract: contract(),
      userId: STRANGER.id,
      contentHash: 'f'.repeat(64),
      slug: 'chosen_name',
      state: 'live',
      enabled: false,
    } as never);
    const doc = await stored(view.id);
    expect(doc).toMatchObject({
      ownerKey: OWNER.id,
      userId: OWNER.id,
      slug: 'beam_midspan_deflection',
      state: 'draft',
      enabled: true,
    });
    expect(doc?.pin.contentHash).toBe(sha256(code()));
  });

  it('refuses content whose stored hash disagrees with its code (hash_mismatch) and writes nothing', async () => {
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    await ArtifactContent.updateOne({ artifactId: 'artifact-1' }, { $set: { contentHash: 'f'.repeat(64) } });

    await expect(save()).rejects.toMatchObject({ statusCode: 409, additionalInfo: { code: 'hash_mismatch' } });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('does not match its hash'), {
      artifactId: 'artifact-1',
      version: 1,
    });
    expect(await CallableFunction.countDocuments({})).toBe(0);
  });

  it('answers 404 when the head version has no stored content and writes nothing', async () => {
    await ArtifactContent.deleteMany({ artifactId: 'artifact-1' });

    await expect(save()).rejects.toMatchObject({ statusCode: 404, message: 'Artifact version not found' });
    expect(await CallableFunction.countDocuments({})).toBe(0);
  });

  it('refuses a stale expected version (version_changed) and names the head', async () => {
    await addVersion('artifact-1', code('# edited\n'));
    await expect(save()).rejects.toMatchObject({
      statusCode: 409,
      additionalInfo: { code: 'version_changed', version: 2 },
    });
    expect(await CallableFunction.countDocuments({})).toBe(0);
  });

  it("answers 404 for another person's artifact, a collaborator with write access, a deleted one, and a missing one", async () => {
    await seedArtifact('theirs', { userId: STRANGER.id });
    await seedArtifact('shared', { userId: STRANGER.id, canWrite: [OWNER.id] });
    await seedArtifact('trashed');
    await artifactRepository.softDelete('trashed');

    for (const artifactId of ['theirs', 'shared', 'trashed', 'missing']) {
      await expect(save(artifactId)).rejects.toMatchObject({ statusCode: 404, message: 'Artifact not found' });
    }
    expect(await CallableFunction.countDocuments({})).toBe(0);
  });

  it('refuses an artifact that is not Python (not_python)', async () => {
    await seedArtifact('page', { type: 'html' });
    await expect(save('page')).rejects.toMatchObject({ statusCode: 400, additionalInfo: { code: 'not_python' } });
  });

  it('refuses code over 256 KB (source_too_large)', async () => {
    await seedArtifact('big', { content: code(`# ${'x'.repeat(300 * 1024)}\n`) });
    await expect(save('big')).rejects.toMatchObject({ statusCode: 400, additionalInfo: { code: 'source_too_large' } });
  });

  it('refuses code with no FUNCTION contract and run function (no_entry_point)', async () => {
    await seedArtifact('script', { content: 'print("hello")\n' });
    await expect(save('script')).rejects.toMatchObject({ statusCode: 400, additionalInfo: { code: 'no_entry_point' } });
  });

  it('refuses a contract parseFunctionContract rejects (invalid_contract) and lists the problems', async () => {
    const inputs = { type: 'object', additionalProperties: false, properties: { x: { type: 'number' } } };
    await expect(save('artifact-1', { contract: contract({ inputs }) })).rejects.toMatchObject({
      statusCode: 400,
      additionalInfo: {
        code: 'invalid_contract',
        problems: expect.arrayContaining([expect.objectContaining({ path: 'inputs.properties.x.unit' })]),
      },
    });
  });

  it('refuses an oversized contract (invalid_contract)', async () => {
    const oversized = contract({ description: 'x'.repeat(40 * 1024) });
    await expect(save('artifact-1', { contract: oversized })).rejects.toMatchObject({
      statusCode: 400,
      additionalInfo: {
        code: 'invalid_contract',
        problems: [expect.objectContaining({ message: expect.stringMatching(/at most 32768 are allowed/) })],
      },
    });
  });

  it.each(['a__b', 'beam_'])('refuses the name %s (invalid_name)', async name => {
    await expect(save('artifact-1', { contract: contract({ name }) })).rejects.toMatchObject({
      statusCode: 400,
      additionalInfo: { code: 'invalid_name' },
    });
  });

  it('refuses a second function with the same name (slug_taken) and names the holder, whose artifact is live', async () => {
    const holder = await save();
    await seedArtifact('copy');
    await expect(save('copy')).rejects.toMatchObject({
      statusCode: 409,
      message: 'You already have a tool named beam_midspan_deflection.',
      additionalInfo: {
        code: 'slug_taken',
        slug: 'beam_midspan_deflection',
        functionId: holder.id,
        sourceDeleted: false,
      },
    });
  });

  it('slug_taken says the holder lost its artifact, turned off or not, and a delete then lets the save through', async () => {
    const holder = await save();
    await artifactRepository.softDelete('artifact-1');
    await seedArtifact('copy');
    const orphaned = { code: 'slug_taken', functionId: holder.id, sourceDeleted: true };
    await expect(save('copy')).rejects.toMatchObject({ statusCode: 409, additionalInfo: orphaned });

    await setCallableFunctionEnabled(OWNER, holder.id, false);
    await expect(save('copy')).rejects.toMatchObject({ statusCode: 409, additionalInfo: orphaned });

    await deleteCallableFunction(OWNER, holder.id);
    expect(await save('copy')).toMatchObject({ slug: 'beam_midspan_deflection', pin: { artifactId: 'copy' } });
  });

  it('saves a second function from the same artifact under another name and leaves the first as it was', async () => {
    const first = await save();
    const before = await stored(first.id);
    const second = await save('artifact-1', { contract: contract({ name: 'other_name' }) });
    expect(second).toMatchObject({ slug: 'other_name', pin: { artifactId: 'artifact-1' } });
    expect(await stored(first.id)).toEqual(before);
  });

  it('refuses a create past the per-owner limit (function_limit)', async () => {
    const { maxPerOwner } = CALLABLE_FUNCTION_LIMITS;
    const template = (await stored((await save()).id))!;
    await CallableFunction.deleteMany({});
    await CallableFunction.insertMany(
      Array.from({ length: maxPerOwner }, (_, n) => ({
        ...template,
        _id: new mongoose.Types.ObjectId(),
        slug: `fn_${n}`,
        pin: { ...template.pin, artifactId: `seeded-${n}` },
      }))
    );

    await expect(save()).rejects.toMatchObject({
      statusCode: 409,
      message: `You can have at most ${maxPerOwner} saved tools.`,
      additionalInfo: { code: 'function_limit', limit: maxPerOwner },
    });
    expect(await CallableFunction.countDocuments({ ownerKey: OWNER.id })).toBe(maxPerOwner);
  });
});

describe('reading saved functions', () => {
  it('reports a newer artifact version as an available update and keeps the pin', async () => {
    const view = await save();
    await addVersion('artifact-1', code('# edited\n'));

    const [listed] = await listCallableFunctions(OWNER);
    expect(listed).toMatchObject({ status: 'draft', latestVersion: 2, updateAvailable: true, pin: { version: 1 } });
    const detail = await getCallableFunction(OWNER, view.id);
    expect(detail).toMatchObject({ updateAvailable: true, source: code() });
  });

  it('reads as source_deleted once the artifact is deleted, and keeps the pinned code', async () => {
    const view = await save();
    await artifactRepository.softDelete('artifact-1');

    const [listed] = await listCallableFunctions(OWNER);
    expect(listed).toMatchObject({ status: 'source_deleted', updateAvailable: false });
    expect(await getCallableFunction(OWNER, view.id)).toMatchObject({ status: 'source_deleted', source: code() });

    await Artifact.deleteMany({ id: 'artifact-1' });
    expect(await getCallableFunction(OWNER, view.id)).toMatchObject({ status: 'source_deleted', latestVersion: null });
  });

  it('reads as source_deleted once the artifact belongs to someone else', async () => {
    const view = await save();
    await Artifact.updateOne({ id: 'artifact-1' }, { $set: { userId: STRANGER.id } });
    expect(await getCallableFunction(OWNER, view.id)).toMatchObject({ status: 'source_deleted', latestVersion: null });
  });

  it('returns the stored contract unchanged with the pinned code', async () => {
    const view = await save();
    const parsed = parseFunctionContract(contract());
    if (!parsed.ok) throw new Error('the sample contract must parse');

    const detail = await getCallableFunction(OWNER, view.id);
    expect(detail.contract).toEqual(parsed.contract);
    expect(detail.contract).toEqual(contract());
    expect(detail.source).toBe(code());
  });

  it("lists only the caller's functions, filtered by artifact", async () => {
    const first = await save();
    await seedArtifact('second');
    await save('second', { contract: contract({ name: 'second_fn' }) });
    await seedArtifact('theirs', { userId: STRANGER.id });
    await createCallableFunction(STRANGER, { artifactId: 'theirs', expectedVersion: 1, contract: contract() });

    expect((await listCallableFunctions(OWNER)).map(fn => fn.slug)).toEqual(['beam_midspan_deflection', 'second_fn']);
    expect((await listCallableFunctions(OWNER, { artifactId: 'artifact-1' })).map(fn => fn.id)).toEqual([first.id]);
    expect(await listCallableFunctions(OWNER, { artifactId: 'theirs' })).toEqual([]);
  });
});

describe('repinCallableFunction', () => {
  it('moves the pin to the head with the new hash and code', async () => {
    const view = await save();
    const version = await addVersion('artifact-1', code('# tuned\n'));

    const repinned = await repinCallableFunction(OWNER, view.id, { expectedVersion: version, contract: contract() });
    expect(repinned).toMatchObject({ updateAvailable: false, latestVersion: 2 });
    expect(repinned.pin).toMatchObject({ version: 2, contentHash: sha256(code('# tuned\n')) });
    expect((await stored(view.id))?.pin.source).toBe(code('# tuned\n'));
  });

  it('refuses a stale expected version (version_changed)', async () => {
    const view = await save();
    await addVersion('artifact-1', code('# tuned\n'));
    await expect(
      repinCallableFunction(OWNER, view.id, { expectedVersion: 1, contract: contract() })
    ).rejects.toMatchObject({ statusCode: 409, additionalInfo: { code: 'version_changed', version: 2 } });
  });

  it('refuses a renamed contract (name_changed) and keeps the pin', async () => {
    const view = await save();
    const version = await addVersion('artifact-1', code('# renamed\n'));
    await expect(
      repinCallableFunction(OWNER, view.id, { expectedVersion: version, contract: contract({ name: 'new_name' }) })
    ).rejects.toMatchObject({ statusCode: 409, additionalInfo: { code: 'name_changed' } });
    expect((await stored(view.id))?.pin.version).toBe(1);
  });

  it('refuses a contract that removes an output or changes a unit (breaking_change) and changes nothing', async () => {
    const view = await save();
    const before = await stored(view.id);
    const version = await addVersion('artifact-1', code('# reworked\n'));
    const next = contract();
    const outputs: Record<string, unknown> = next.outputs.properties;
    delete outputs.deflection;
    outputs.peak = { type: 'number', unit: 'm' };
    next.outputs.required = [];
    next.inputs.properties.load = { type: 'number', unit: 'kN/m', exclusiveMinimum: 0 };

    await expect(
      repinCallableFunction(OWNER, view.id, { expectedVersion: version, contract: next })
    ).rejects.toMatchObject({
      statusCode: 409,
      additionalInfo: {
        code: 'breaking_change',
        changes: [
          { path: 'inputs.load.unit', kind: 'unit_changed', before: 'N/m', after: 'kN/m' },
          { path: 'outputs.deflection', kind: 'removed' },
          { path: 'outputs.peak', kind: 'added' },
        ],
      },
    });
    expect(await stored(view.id)).toEqual(before);
  });

  it('refuses a repin against a stored contract that does not parse (contract_unreadable) and changes nothing', async () => {
    const view = await save();
    await CallableFunction.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(view.id) },
      { $unset: { 'contract.outputs.properties': '' } }
    );
    const before = await stored(view.id);
    const version = await addVersion('artifact-1', code('# reworked\n'));

    await expect(
      repinCallableFunction(OWNER, view.id, { expectedVersion: version, contract: contract() })
    ).rejects.toMatchObject({
      statusCode: 409,
      message: 'The saved contract cannot be read; save this version as a new tool.',
      additionalInfo: { code: 'contract_unreadable' },
    });
    expect(await stored(view.id)).toEqual(before);
  });

  it('repins a contract that only adds an optional input', async () => {
    const view = await save();
    const version = await addVersion('artifact-1', code('# extended\n'));
    const next = contract();
    Object.assign(next.inputs.properties, { depth: { type: 'number', unit: 'm' } });

    const repinned = await repinCallableFunction(OWNER, view.id, { expectedVersion: version, contract: next });
    expect(repinned.pin).toMatchObject({ version: 2, contentHash: sha256(code('# extended\n')) });
    expect(Object.keys((await stored(view.id))!.contract.inputs.properties)).toEqual(['load', 'span', 'depth']);
  });

  it('refuses a contract that adds an output (breaking_change) and changes nothing', async () => {
    const view = await save();
    const before = await stored(view.id);
    const version = await addVersion('artifact-1', code('# extended\n'));
    const next = contract();
    Object.assign(next.outputs.properties, { peak: { type: 'number', unit: 'm' } });

    await expect(
      repinCallableFunction(OWNER, view.id, { expectedVersion: version, contract: next })
    ).rejects.toMatchObject({
      statusCode: 409,
      additionalInfo: { code: 'breaking_change', changes: [{ path: 'outputs.peak', kind: 'added' }] },
    });
    expect(await stored(view.id)).toEqual(before);
  });

  it('answers 404 once the artifact is deleted or belongs to someone else, and keeps the pin', async () => {
    const view = await save();
    const repin = () => repinCallableFunction(OWNER, view.id, { expectedVersion: 1, contract: contract() });

    await Artifact.updateOne({ id: 'artifact-1' }, { $set: { userId: STRANGER.id } });
    await expect(repin()).rejects.toMatchObject({ statusCode: 404, message: 'Artifact not found' });
    await Artifact.updateOne({ id: 'artifact-1' }, { $set: { userId: OWNER.id } });
    await artifactRepository.softDelete('artifact-1');
    await expect(repin()).rejects.toMatchObject({ statusCode: 404, message: 'Artifact not found' });
    expect((await stored(view.id))?.pin).toMatchObject({ version: 1, source: code() });
  });

  it('answers version_changed when another update moved the pin first', async () => {
    const view = await save();
    const version = await addVersion('artifact-1', code('# tuned\n'));
    vi.spyOn(callableFunctionRepository, 'repin').mockResolvedValueOnce(null);
    await expect(
      repinCallableFunction(OWNER, view.id, { expectedVersion: version, contract: contract() })
    ).rejects.toMatchObject({
      statusCode: 409,
      message: 'The tool changed since you opened it. Reload it and try again.',
      additionalInfo: { code: 'version_changed' },
    });
  });
});

describe('setCallableFunctionEnabled', () => {
  it('turning off reads as disabled, and a deleted artifact still reads as source_deleted; on again reads as the state', async () => {
    const view = await save();
    expect(await setCallableFunctionEnabled(OWNER, view.id, false)).toMatchObject({
      enabled: false,
      status: 'disabled',
    });
    await artifactRepository.softDelete('artifact-1');
    expect(await getCallableFunction(OWNER, view.id)).toMatchObject({ enabled: false, status: 'source_deleted' });
    await artifactRepository.restore('artifact-1');
    expect(await getCallableFunction(OWNER, view.id)).toMatchObject({ status: 'disabled' });
    expect(await setCallableFunctionEnabled(OWNER, view.id, true)).toMatchObject({ enabled: true, status: 'draft' });
  });
});

describe('ownership', () => {
  it("answers 404 for another owner's function and a malformed id everywhere, and changes nothing", async () => {
    const view = await save();
    const version = await addVersion('artifact-1', code('# tuned\n'));

    for (const [actor, id] of [
      [STRANGER, view.id],
      [OWNER, 'not-an-id'],
      [OWNER, new mongoose.Types.ObjectId().toHexString()],
    ] as const) {
      await expect(getCallableFunction(actor, id)).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        repinCallableFunction(actor, id, { expectedVersion: version, contract: contract() })
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(setCallableFunctionEnabled(actor, id, false)).rejects.toMatchObject({ statusCode: 404 });
      await expect(deleteCallableFunction(actor, id)).rejects.toMatchObject({ statusCode: 404 });
    }
    expect(await stored(view.id)).toMatchObject({ enabled: true, pin: { version: 1 } });
    expect(await listCallableFunctions(STRANGER)).toEqual([]);
  });

  it('delete removes the record and leaves the artifact; a second delete is 404', async () => {
    const view = await save();
    await deleteCallableFunction(OWNER, view.id);
    expect(await CallableFunction.countDocuments({})).toBe(0);
    expect(await artifactRepository.findOne({ id: 'artifact-1' })).toMatchObject({ version: 1 });
    await expect(deleteCallableFunction(OWNER, view.id)).rejects.toMatchObject({ statusCode: 404 });
  });
});

const OWNER_KEY = { ownerType: 'user' as const, ownerKey: OWNER.id };

/** Promotes through the repository method the promotion service uses. */
async function promoteDirectly(id: string, seq = 1) {
  const fn = await callableFunctionRepository.findByIdForOwner(id, OWNER_KEY);
  const promoted = await callableFunctionRepository.promote(
    id,
    OWNER_KEY,
    { updatedAt: fn!.updatedAt },
    {
      seq,
      runtime: { kind: 'pyodide-server', version: '0.25.1', packages: [] },
      lastServerRun: { at: new Date(), passed: 1, failed: 0, results: [] },
      trustLabel: 'verified',
      contract: fn!.contract,
    }
  );
  expect(promoted).toMatchObject({ state: 'live', trustLabel: 'verified', pin: { seq } });
}

const EXAMPLE = {
  name: 'handbook case',
  input: { load: 1000, span: 4 },
  expected: { deflection: 10.4 },
  tolerance: { rel: 0.01 },
  citation: '  https://data.example.com/beams/table-3  ',
};

describe('repinning a promoted function', () => {
  it('returns a live function to draft and drops its label, keeping the promotion record', async () => {
    const view = await save();
    await promoteDirectly(view.id);
    const version = await addVersion('artifact-1', code('# tuned\n'));

    const repinned = await repinCallableFunction(OWNER, view.id, { expectedVersion: version, contract: contract() });
    expect(repinned).toMatchObject({ state: 'draft', trustLabel: null });
    expect(repinned.pin.seq).toBeUndefined();
    const record = await stored(view.id);
    expect(record?.trustLabel).toBeUndefined();
    expect(record?.promoted).toMatchObject({ seq: 1 });
  });

  it('accepts a breaking contract once promoted, leaving the refusal to the next promotion', async () => {
    const view = await save();
    await promoteDirectly(view.id);
    const version = await addVersion('artifact-1', code('# reworked\n'));
    const next = contract({
      outputs: { type: 'object', additionalProperties: false, required: [], properties: {} },
    });

    const repinned = await repinCallableFunction(OWNER, view.id, { expectedVersion: version, contract: next });
    expect(repinned).toMatchObject({ state: 'draft', pin: { version: 2 } });
  });
});

describe('setCallableFunctionExamples', () => {
  it('stores the examples with the citation trimmed, and the label waits for a promotion', async () => {
    const view = await save();
    const saved = await setCallableFunctionExamples(OWNER, view.id, [EXAMPLE]);
    expect(saved.examples).toEqual([{ ...EXAMPLE, citation: 'https://data.example.com/beams/table-3' }]);
    expect(saved.trustLabel).toBeNull();
    expect((await stored(view.id))?.examples).toHaveLength(1);
  });

  it('refuses an example without a citation, or one that does not fit the contract, and changes nothing', async () => {
    const view = await save();
    await expect(
      setCallableFunctionExamples(OWNER, view.id, [
        { ...EXAMPLE, citation: '   ' },
        { ...EXAMPLE, name: 'bad', input: { load: -1, span: 4 }, expected: { peak: 1 } },
      ])
    ).rejects.toMatchObject({
      statusCode: 400,
      additionalInfo: {
        code: 'invalid_examples',
        problems: expect.arrayContaining([
          expect.objectContaining({ path: 'examples.0.citation' }),
          expect.objectContaining({ path: 'examples.1.input.load' }),
          expect.objectContaining({ path: 'examples.1.expected.peak', message: 'is not an output of the contract' }),
        ]),
      },
    });
    expect((await stored(view.id))?.examples).toBeUndefined();
  });

  it("answers 404 for another owner's function", async () => {
    const view = await save();
    await expect(setCallableFunctionExamples(STRANGER, view.id, [EXAMPLE])).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe('callableFunctionRepository.promote', () => {
  it('writes nothing when the record changed since it was read', async () => {
    const view = await save();
    const read = await callableFunctionRepository.findByIdForOwner(view.id, OWNER_KEY);
    await setCallableFunctionExamples(OWNER, view.id, [EXAMPLE]);
    const before = await stored(view.id);
    const promoted = await callableFunctionRepository.promote(
      view.id,
      OWNER_KEY,
      { updatedAt: read!.updatedAt },
      {
        seq: 1,
        runtime: { kind: 'pyodide-server', version: '0.25.1', packages: [] },
        lastServerRun: { at: new Date(), passed: 1, failed: 0, results: [] },
        trustLabel: 'unverified',
        contract: read!.contract,
      }
    );
    expect(promoted).toBeNull();
    expect(await stored(view.id)).toEqual(before);
  });
});

describe('the protected fields', () => {
  it.each([
    ['state', { state: 'live' }],
    ['trustLabel', { trustLabel: 'verified' }],
    ['lastServerRun', { lastServerRun: { passed: 9 } }],
    ['promoted', { promoted: { seq: 9 } }],
    ['examples', { examples: [] }],
    ['pin', { 'pin.seq': 9 }],
    ['pin', { 'pin.runtime': { kind: 'x', version: '1', packages: [] } }],
  ])('a generic update cannot write %s', async (field, data) => {
    const view = await save();
    const before = await stored(view.id);
    await expect(callableFunctionRepository.update({ id: view.id, ...data } as never)).rejects.toMatchObject({
      name: 'CallableFunctionProtectedFieldError',
      field,
    });
    await expect(callableFunctionRepository.updateMany({ _id: view.id }, data as never)).rejects.toMatchObject({
      field,
    });
    expect(await stored(view.id)).toEqual(before);
  });
});

describe('summarizeCallableFunctionCalls', () => {
  const NOW = new Date('2026-11-23T12:00:00.000Z');
  const DAY = 24 * 60 * 60 * 1000;
  const row = (functionId: string, daysAgo: number, outcome: 'ok' | 'error' | 'timeout', caller = OWNER.id) =>
    CallableFunctionCall.create({
      functionId,
      ownerUserId: OWNER.id,
      callerUserId: caller,
      surface: 'test',
      inputHash: 'b'.repeat(64),
      dataHashes: [],
      startedAt: new Date(NOW.getTime() - daysAgo * DAY),
      durationMs: 10,
      outcome,
    });

  afterEach(async () => {
    await CallableFunctionCall.deleteMany({});
  });

  it("counts the owner's calls of the last 30 days by outcome and lists the latest five, without inputs", async () => {
    const view = await save();
    for (const [days, outcome] of [
      [1, 'ok'],
      [2, 'ok'],
      [3, 'error'],
      [4, 'ok'],
      [5, 'timeout'],
      [6, 'ok'],
      [29.9, 'ok'],
    ] as const) {
      await row(view.id, days, outcome);
    }
    await row(view.id, 31, 'ok');
    await row(view.id, 1, 'ok', STRANGER.id);
    await row('6650f0a1b2c3d4e5f6a7b8c9', 1, 'ok');

    const summary = await summarizeCallableFunctionCalls(OWNER, view.id, NOW);
    expect(summary).toMatchObject({ since: new Date(NOW.getTime() - 30 * DAY), total: 7 });
    expect(summary.outcomes).toEqual({ ok: 5, error: 1, timeout: 1 });
    expect(summary.recent.map(call => call.outcome)).toEqual(['ok', 'ok', 'error', 'ok', 'timeout']);
    expect(summary.recent[0]).toEqual({
      id: expect.any(String),
      startedAt: new Date(NOW.getTime() - DAY),
      outcome: 'ok',
      surface: 'test',
    });
  });

  it("answers 404 for another owner's function", async () => {
    const view = await save();
    await expect(summarizeCallableFunctionCalls(STRANGER, view.id, NOW)).rejects.toMatchObject({ statusCode: 404 });
  });
});
