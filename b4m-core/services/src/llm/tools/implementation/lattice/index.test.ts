import { describe, it, expect, vi, beforeEach } from 'vitest';
import { latticeAddEntityTool, latticeSetValueTool, latticeCreateRuleTool } from './index';

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

describe('Lattice tools - failed writes report success: false', () => {
  beforeEach(() => vi.clearAllMocks());

  const setValue = (
    context: Parameters<typeof latticeSetValueTool.implementation>[0],
    entityName: string,
    attributeKey: string
  ) =>
    latticeSetValueTool.implementation(context).toolFn({ modelId: MODEL_ID, entityName, attributeKey, value: '175' });

  it('lattice_set_value against a missing entity writes nothing and lists the entities present', async () => {
    const { context, update } = makeContext('owner', 'owner');
    const result = JSON.parse(await setValue(context, 'Headcount', 'current'));
    expect(update).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toContain('"Headcount"');
    expect(result.error).toContain('Available entities: "Revenue"');
  });

  it('lattice_set_value points split name/period arguments at the per-period entity', async () => {
    const { context, update } = makeContext('owner', 'owner');
    const model = await context.db.latticeModels.findById(MODEL_ID);
    model.data.entities = [{ id: 'revenue_q2', name: 'Revenue Q2', attributes: [] }];
    const result = JSON.parse(await setValue(context, 'Revenue', 'Q2'));
    expect(update).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toContain('entityName="Revenue Q2", attributeKey="value"');
  });

  it('lattice_set_value matches an entity name case-insensitively', async () => {
    const { context, update } = makeContext('owner', 'owner');
    const result = JSON.parse(await setValue(context, 'REVENUE', 'value'));
    expect(update).toHaveBeenCalledOnce();
    expect(result.success).toBe(true);
  });

  it('lattice_set_value matches a multi-word entity name ignoring case and extra whitespace', async () => {
    const { context, update } = makeContext('owner', 'owner');
    const model = await context.db.latticeModels.findById(MODEL_ID);
    model.data.entities = [{ id: 'revenue_q2', name: 'Revenue Q2', attributes: [] }];
    const result = JSON.parse(await setValue(context, 'revenue  q2', 'value'));
    expect(update).toHaveBeenCalledOnce();
    expect(result.success).toBe(true);
    expect(model.data.entities[0].attributes).toEqual([expect.objectContaining({ key: 'value', value: 175 })]);
  });

  it('lattice_set_value caps the listed entities and counts the rest', async () => {
    const { context } = makeContext('owner', 'owner');
    const model = await context.db.latticeModels.findById(MODEL_ID);
    model.data.entities = Array.from({ length: 53 }, (_, i) => ({
      id: `item_${i}`,
      name: `Item ${i}`,
      attributes: [],
    }));
    const { error } = JSON.parse(await setValue(context, 'Missing', 'value'));
    expect(error).toContain('"Item 49"');
    expect(error).not.toContain('"Item 50"');
    expect(error).toContain('(and 3 more)');
  });

  it('lattice_set_value reports a failed save as success: false', async () => {
    const { context, update } = makeContext('owner', 'owner');
    update.mockRejectedValueOnce(new Error('write failed'));
    const result = JSON.parse(await setValue(context, 'Revenue', 'value'));
    expect(result.success).toBe(false);
  });

  it('lattice_add_entity reports a failed save as success: false', async () => {
    const { context, update } = makeContext('owner', 'owner');
    update.mockRejectedValueOnce(new Error('write failed'));
    const result = await latticeAddEntityTool.implementation(context).toolFn({
      modelId: MODEL_ID,
      name: 'Costs',
      type: 'line_item',
    });
    expect(JSON.parse(result).success).toBe(false);
  });

  it('lattice_create_rule reports a failed save as success: false', async () => {
    const { context, update } = makeContext('owner', 'owner');
    update.mockRejectedValueOnce(new Error('write failed'));
    const result = await latticeCreateRuleTool.implementation(context).toolFn({
      modelId: MODEL_ID,
      name: 'Margin Rule',
      formula: 'Revenue = Costs + Margin',
    });
    expect(JSON.parse(result).success).toBe(false);
  });
});
