import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import {
  getModel,
  listModels,
  updateModel,
  deleteModel,
  addEntity,
  setValue,
  addRule,
  hydrateModel,
} from './latticeModelService';
import type { LatticeModelServiceDeps, LatticeModelUser } from './latticeModelService';

/**
 * Read access to a lattice model is org-wide by design; WRITE access is not. Every mutator used to
 * take its authorization from `getModel`, so any colleague in the same organization could rename,
 * re-value or delete a model they did not create. These pin the two apart.
 */
describe('latticeModelService write authority', () => {
  const owner: LatticeModelUser = { id: 'owner-id', organizationId: 'org-1' };
  const colleague: LatticeModelUser = { id: 'colleague-id', organizationId: 'org-1' };
  const outsider: LatticeModelUser = { id: 'outsider-id', organizationId: 'org-2' };

  const model = {
    id: 'model-1',
    name: 'Test Model',
    userId: 'owner-id',
    organizationId: 'org-1',
    settings: {},
    data: {
      entities: [
        {
          id: 'e1',
          type: 'thing',
          name: 'Entity One',
          attributes: [{ key: 'attr', value: 1, dataType: 'number', isComputed: false }],
          metadata: {},
        },
      ],
      relationships: [],
    },
    rules: { rules: [], rulesets: [] },
    views: [],
    scenarios: [],
    operations: [],
    operationIndex: -1,
  };

  let deps: LatticeModelServiceDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = {
      db: {
        latticeModels: {
          findById: vi.fn().mockResolvedValue({ ...model }),
          update: vi.fn().mockImplementation(async (u: unknown) => u),
          delete: vi.fn().mockResolvedValue(undefined),
        },
      },
    } as unknown as LatticeModelServiceDeps;
  });

  it('lets the owner read their own model', async () => {
    await expect(getModel(owner, 'model-1', deps)).resolves.toMatchObject({ id: 'model-1' });
  });

  it('lets the owner update their own model', async () => {
    await expect(updateModel(owner, 'model-1', { name: 'Renamed' }, deps)).resolves.not.toBeNull();
    expect(deps.db.latticeModels.update).toHaveBeenCalled();
  });

  it('lets the owner delete their own model', async () => {
    await expect(deleteModel(owner, 'model-1', deps)).resolves.toBe(true);
    expect(deps.db.latticeModels.delete).toHaveBeenCalledWith('model-1');
  });

  it('refuses an update from a same-org colleague who does not own the model', async () => {
    await expect(updateModel(colleague, 'model-1', { name: 'Hijacked' }, deps)).resolves.toBeNull();
    expect(deps.db.latticeModels.update).not.toHaveBeenCalled();
  });

  it('refuses a delete from a same-org colleague who does not own the model', async () => {
    await expect(deleteModel(colleague, 'model-1', deps)).resolves.toBe(false);
    expect(deps.db.latticeModels.delete).not.toHaveBeenCalled();
  });

  it('refuses an update from a user outside the organization', async () => {
    await expect(updateModel(outsider, 'model-1', { name: 'Hijacked' }, deps)).resolves.toBeNull();
    expect(deps.db.latticeModels.update).not.toHaveBeenCalled();
  });

  // The other three mutators share the gate; pinning only update/delete would let a refactor
  // reintroduce the hole on whichever one was left untested. Each is asserted BOTH ways in the same
  // test: these all return null on a missing entity/model too, so a bare "colleague gets null" is
  // satisfied by a broken fixture and proves nothing.
  const newEntity = { id: 'e2', name: 'Entity Two', type: 'thing', attributes: [], metadata: {} };
  const newRule = {
    id: 'r1',
    name: 'Rule One',
    type: 'formula',
    definition: {},
    dependencies: [],
    priority: 0,
    enabled: true,
  };

  it('refuses addEntity from a same-org colleague, where the owner succeeds', async () => {
    await expect(addEntity(owner, 'model-1', newEntity as never, deps)).resolves.not.toBeNull();
    expect(deps.db.latticeModels.update).toHaveBeenCalled();

    vi.clearAllMocks();
    await expect(addEntity(colleague, 'model-1', newEntity as never, deps)).resolves.toBeNull();
    expect(deps.db.latticeModels.update).not.toHaveBeenCalled();
  });

  it('refuses setValue from a same-org colleague, where the owner succeeds', async () => {
    await expect(setValue(owner, 'model-1', 'e1', 'attr', 42, deps)).resolves.not.toBeNull();
    expect(deps.db.latticeModels.update).toHaveBeenCalled();

    vi.clearAllMocks();
    await expect(setValue(colleague, 'model-1', 'e1', 'attr', 42, deps)).resolves.toBeNull();
    expect(deps.db.latticeModels.update).not.toHaveBeenCalled();
  });

  it('refuses addRule from a same-org colleague, where the owner succeeds', async () => {
    await expect(addRule(owner, 'model-1', newRule as never, deps)).resolves.not.toBeNull();
    expect(deps.db.latticeModels.update).toHaveBeenCalled();

    vi.clearAllMocks();
    await expect(addRule(colleague, 'model-1', newRule as never, deps)).resolves.toBeNull();
    expect(deps.db.latticeModels.update).not.toHaveBeenCalled();
  });

  // The other half of the pair: narrowing writes must NOT narrow reads. A colleague can still open
  // the model and compute its derived values - hydration writes only a lastComputedAt stamp.
  it('still lets a same-org colleague read and hydrate the model', async () => {
    await expect(getModel(colleague, 'model-1', deps)).resolves.toMatchObject({ id: 'model-1' });
    await expect(hydrateModel(colleague, 'model-1', deps)).resolves.toMatchObject({ errors: [] });
  });

  it('returns null rather than throwing when the model does not exist', async () => {
    (deps.db.latticeModels.findById as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(updateModel(owner, 'missing', { name: 'x' }, deps)).resolves.toBeNull();
    await expect(deleteModel(owner, 'missing', deps)).resolves.toBe(false);
  });
});

/**
 * The org arm of the read gate never fired: `LatticeModel.organizationId` is a String schema path
 * while `req.user.organizationId` is an ObjectId on the hydrated user document, so the comparison
 * was String vs ObjectId and always false. The suite above uses plain strings on both sides, which
 * is exactly why it could not catch this - these pin the real runtime shapes.
 */
describe('latticeModelService org-shared read access across id types', () => {
  const orgObjectId = new Types.ObjectId();
  const otherOrgObjectId = new Types.ObjectId();

  // What the routes actually pass: `{ id: user.id, organizationId: user.organizationId }` off a
  // hydrated Mongoose user, so the org id is an ObjectId, not a string.
  const colleague: LatticeModelUser = { id: 'colleague-id', organizationId: orgObjectId };
  const outsider: LatticeModelUser = { id: 'outsider-id', organizationId: otherOrgObjectId };
  const orgless: LatticeModelUser = { id: 'orgless-id' };

  // What the collection actually stores: the String cast of that same ObjectId.
  const model = {
    id: 'model-1',
    name: 'Org Model',
    userId: 'owner-id',
    organizationId: orgObjectId.toHexString(),
    settings: {},
    data: { entities: [], relationships: [] },
    rules: { rules: [], rulesets: [] },
    views: [],
    scenarios: [],
    operations: [],
    operationIndex: -1,
  };

  let deps: LatticeModelServiceDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = {
      db: {
        latticeModels: {
          findById: vi.fn().mockResolvedValue({ ...model }),
          findBySessionId: vi.fn().mockResolvedValue([{ ...model }]),
          findByProjectId: vi.fn().mockResolvedValue([{ ...model }]),
          update: vi.fn().mockImplementation(async (u: unknown) => u),
        },
      },
    } as unknown as LatticeModelServiceDeps;
  });

  it('lets a same-org non-owner read a model whose org id is stored as a string', async () => {
    await expect(getModel(colleague, 'model-1', deps)).resolves.toMatchObject({ id: 'model-1' });
  });

  it('lists an org-shared model to a same-org non-owner on the session branch', async () => {
    const result = await listModels(colleague, { sessionId: 'session-1' }, deps);
    expect(result.models).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it('lists an org-shared model to a same-org non-owner on the project branch', async () => {
    const result = await listModels(colleague, { projectId: 'project-1' }, deps);
    expect(result.models).toHaveLength(1);
  });

  it('still hides the model from a user in a different organization', async () => {
    await expect(getModel(outsider, 'model-1', deps)).resolves.toBeNull();
    await expect(listModels(outsider, { sessionId: 'session-1' }, deps)).resolves.toMatchObject({ models: [] });
  });

  it('still hides the model from a user with no organization', async () => {
    await expect(getModel(orgless, 'model-1', deps)).resolves.toBeNull();
  });

  // Two org-less principals must not match each other through a pair of undefined ids.
  it('does not treat two org-less users as sharing an organization', async () => {
    (deps.db.latticeModels.findById as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...model,
      organizationId: undefined,
    });
    await expect(getModel(orgless, 'model-1', deps)).resolves.toBeNull();
  });

  // Reads widening must not widen writes: this is the gate #2783 installed.
  it('still refuses a write from the same-org non-owner it now admits for reads', async () => {
    await expect(updateModel(colleague, 'model-1', { name: 'Hijacked' }, deps)).resolves.toBeNull();
    expect(deps.db.latticeModels.update).not.toHaveBeenCalled();
  });
});
