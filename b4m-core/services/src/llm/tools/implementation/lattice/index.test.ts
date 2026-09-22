import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';
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
