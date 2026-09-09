import { describe, it, expect, vi, beforeEach } from 'vitest';
import { latticeAddEntityTool, latticeSetValueTool, latticeCreateRuleTool } from './index';

// 24-hex id so the persistence path's `/^[a-f0-9]{24}$/` gate is satisfied.
const MODEL_ID = 'a'.repeat(24);

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
