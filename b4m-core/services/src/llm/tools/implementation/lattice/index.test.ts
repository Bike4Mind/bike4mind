import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import { latticeCreateModelTool, latticeAddEntityTool, latticeSetValueTool, latticeCreateRuleTool } from './index';
import { canReadModel } from '../../../../latticeService/latticeModelService';

// 24-hex id so the persistence path's `isObjectIdShaped` gate is satisfied.
const MODEL_ID = 'a'.repeat(24);
// Same id, uppercased - Mongo accepts all-case hex, so this must take the persist branch too.
const UPPERCASE_MODEL_ID = MODEL_ID.toUpperCase();

const makeContext = (modelUserId: string, callerUserId: string) => {
  const update = vi.fn().mockResolvedValue(null);
  const model = {
    id: MODEL_ID,
    userId: modelUserId,
    data: { entities: [{ id: 'revenue', name: 'Revenue', attributes: [] }], relationships: [] },
    rules: { rules: [], rulesets: [] },
  };
  const context = {
    userId: callerUserId,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    db: {
      latticeModels: {
        findById: vi.fn().mockResolvedValue(model),
        update,
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal tool context for this unit test
  } as any;
  return { context, update };
};

describe('Lattice tools - owner-only object-level authz', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lattice_add_entity does not overwrite a model owned by another user', async () => {
    const { context, update } = makeContext('victim', 'attacker');
    const result = await latticeAddEntityTool.implementation(context).toolFn({
      modelId: MODEL_ID,
      name: 'Injected',
      type: 'line_item',
      initialValues: [],
    });
    expect(update).not.toHaveBeenCalled();
    expect(JSON.parse(result).success).toBe(false);
  });

  it('lattice_add_entity persists to a model the caller owns', async () => {
    const { context, update } = makeContext('owner', 'owner');
    const result = await latticeAddEntityTool.implementation(context).toolFn({
      modelId: MODEL_ID,
      name: 'Revenue',
      type: 'line_item',
      initialValues: [],
    });
    expect(update).toHaveBeenCalledOnce();
    expect(JSON.parse(result).success).toBe(true);
  });

  it('lattice_add_entity persists when modelId is uppercase-hex (#2544)', async () => {
    const { context, update } = makeContext('owner', 'owner');
    const result = await latticeAddEntityTool.implementation(context).toolFn({
      modelId: UPPERCASE_MODEL_ID,
      name: 'Revenue',
      type: 'line_item',
      initialValues: [],
    });
    expect(update).toHaveBeenCalledOnce();
    expect(JSON.parse(result).success).toBe(true);
  });

  it('lattice_set_value does not overwrite a model owned by another user', async () => {
    const { context, update } = makeContext('victim', 'attacker');
    const result = await latticeSetValueTool.implementation(context).toolFn({
      modelId: MODEL_ID,
      entityName: 'Revenue',
      attributeKey: 'value',
      value: '999',
    });
    expect(update).not.toHaveBeenCalled();
    expect(JSON.parse(result).success).toBe(false);
  });

  it('lattice_set_value persists to a model the caller owns', async () => {
    const { context, update } = makeContext('owner', 'owner');
    const result = await latticeSetValueTool.implementation(context).toolFn({
      modelId: MODEL_ID,
      entityName: 'Revenue',
      attributeKey: 'value',
      value: '999',
    });
    expect(update).toHaveBeenCalledOnce();
    expect(JSON.parse(result).success).toBe(true);
  });

  it('lattice_create_rule does not overwrite a model owned by another user', async () => {
    const { context, update } = makeContext('victim', 'attacker');
    const result = await latticeCreateRuleTool.implementation(context).toolFn({
      modelId: MODEL_ID,
      name: 'Injected Rule',
      formula: 'Revenue = Costs + Margin',
    });
    expect(update).not.toHaveBeenCalled();
    expect(JSON.parse(result).success).toBe(false);
  });

  it('lattice_create_rule persists to a model the caller owns', async () => {
    const { context, update } = makeContext('owner', 'owner');
    const result = await latticeCreateRuleTool.implementation(context).toolFn({
      modelId: MODEL_ID,
      name: 'Margin Rule',
      formula: 'Revenue = Costs + Margin',
    });
    expect(update).toHaveBeenCalledOnce();
    expect(JSON.parse(result).success).toBe(true);
  });
});

/**
 * These tools share `isModelOwner` with `latticeModelService.getModelForWrite` rather than
 * comparing raw, so a same-org non-owner - who CAN now read the model over HTTP - still cannot
 * make the subagent write to it.
 */
describe('Lattice tools - org sharing does not confer write authority', () => {
  beforeEach(() => vi.clearAllMocks());

  const makeOrgContext = () => {
    const orgId = new Types.ObjectId();
    const update = vi.fn().mockResolvedValue(null);
    const context = {
      userId: 'colleague',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      db: {
        latticeModels: {
          findById: vi.fn().mockResolvedValue({
            id: MODEL_ID,
            userId: 'owner',
            organizationId: orgId.toHexString(),
            data: { entities: [{ id: 'revenue', name: 'Revenue', attributes: [] }], relationships: [] },
            rules: { rules: [], rulesets: [] },
          }),
          update,
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal tool context for this unit test
    } as any;
    return { context, update };
  };

  it('lattice_set_value refuses a same-org non-owner', async () => {
    const { context, update } = makeOrgContext();
    const result = await latticeSetValueTool.implementation(context).toolFn({
      modelId: MODEL_ID,
      entityName: 'Revenue',
      attributeKey: 'value',
      value: '999',
    });
    expect(update).not.toHaveBeenCalled();
    expect(JSON.parse(result).success).toBe(false);
  });
});

/**
 * The create tool writes to the repository directly rather than through `createModel`, so it used
 * to build its own document - and that document carried neither `organizationId` nor `sessionId`.
 * Every model made the way users actually make them (by asking in chat) was therefore owner-only
 * and missing from the session-scoped list, which no amount of fixing the read gate would show.
 */
describe('lattice_create_model - scoping fields a shared model cannot do without', () => {
  beforeEach(() => vi.clearAllMocks());

  const SESSION_ID = 'b'.repeat(24);

  const makeCreateContext = () => {
    const create = vi.fn().mockImplementation(async (data: Record<string, unknown>) => ({ ...data, id: MODEL_ID }));
    const orgId = new Types.ObjectId();
    const context = {
      userId: 'owner',
      // An ObjectId, as it is on a hydrated `req.user` - the shape the raw comparison choked on.
      user: { id: 'owner', organizationId: orgId },
      sessionId: SESSION_ID,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      db: { latticeModels: { create, findById: vi.fn(), update: vi.fn() } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal tool context for this unit test
    } as any;
    return { context, create, orgId };
  };

  it('stamps the caller organization, normalized off an ObjectId user document', async () => {
    const { context, create, orgId } = makeCreateContext();
    await latticeCreateModelTool.implementation(context).toolFn({ name: 'Org Share Test' });
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0].organizationId).toBe(orgId.toHexString());
  });

  it('stamps the session it was created in, so the session-scoped list can find it', async () => {
    const { context, create } = makeCreateContext();
    await latticeCreateModelTool.implementation(context).toolFn({ name: 'Org Share Test' });
    expect(create.mock.calls[0][0].sessionId).toBe(SESSION_ID);
  });

  it('produces a model a same-org colleague can read', async () => {
    const { context, create, orgId } = makeCreateContext();
    await latticeCreateModelTool.implementation(context).toolFn({ name: 'Org Share Test' });
    const persisted = create.mock.calls[0][0];
    expect(canReadModel(persisted, { id: 'colleague', organizationId: orgId })).toBe(true);
    expect(canReadModel(persisted, { id: 'outsider', organizationId: new Types.ObjectId() })).toBe(false);
  });

  it('still persists the entities requested in the same insert', async () => {
    const { context, create } = makeCreateContext();
    await latticeCreateModelTool.implementation(context).toolFn({
      name: 'Org Share Test',
      initialData: { entities: [{ name: 'Revenue', values: [{ period: 'Q1', value: 100 }] }] },
    });
    expect(create.mock.calls[0][0].data.entities).toHaveLength(1);
  });

  // A harness with no session (the CLI, an agent run) must still create, just unscoped.
  it('creates without a session id when the context carries none', async () => {
    const { context, create } = makeCreateContext();
    context.sessionId = undefined;
    await latticeCreateModelTool.implementation(context).toolFn({ name: 'Unscoped' });
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0].sessionId).toBeUndefined();
  });
});
