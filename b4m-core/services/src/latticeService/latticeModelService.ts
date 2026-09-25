/**
 * Lattice Model Service
 *
 * Business logic for Lattice model CRUD operations and hydration.
 * Handles persistence, validation, and computation orchestration.
 */

import type {
  ILatticeModel,
  ILatticeEntity,
  ILatticeRule,
  ILatticeOperation,
  ILatticeComputedValues,
  LatticeModelType,
  PrimitiveValue,
} from '@bike4mind/common';
import { normalizeId } from '@bike4mind/utils';
import { HydrationEngine } from './HydrationEngine';

// TYPES

/**
 * Database adapter interface for lattice model operations
 */
export interface ILatticeModelRepository {
  findById(id: string): Promise<ILatticeModel | null>;
  findByUserId(userId: string, options?: { limit?: number; skip?: number }): Promise<ILatticeModel[]>;
  findBySessionId(sessionId: string): Promise<ILatticeModel[]>;
  findByProjectId(projectId: string): Promise<ILatticeModel[]>;
  create(data: Partial<ILatticeModel>): Promise<ILatticeModel>;
  update(data: Partial<ILatticeModel>): Promise<ILatticeModel | null>;
  delete(id: string): Promise<unknown>;
  count(filter: Record<string, unknown>): Promise<number>;
  search(userId: string, query: string, limit?: number): Promise<ILatticeModel[]>;
  incrementVersion(modelId: string): Promise<ILatticeModel | null>;
}

/**
 * Service dependencies injected at runtime
 */
export interface LatticeModelServiceDeps {
  db: {
    latticeModels: ILatticeModelRepository;
  };
}

/**
 * User context for authorization.
 *
 * Both ids are id-ish rather than `string` because callers pass them straight off a hydrated
 * Mongoose `req.user`, where `organizationId` is an ObjectId. Never compare either field raw -
 * go through `canReadModel` / `isModelOwner`, which normalize both sides.
 */
export interface LatticeModelUser {
  id: string;
  organizationId?: unknown;
}

/**
 * Options for creating a new model
 */
export interface CreateModelOptions {
  name: string;
  description?: string;
  modelType?: LatticeModelType;
  sessionId?: string;
  projectId?: string;
}

/**
 * Options for updating a model
 */
export interface UpdateModelOptions {
  name?: string;
  description?: string;
  settings?: Partial<ILatticeModel['settings']>;
}

/**
 * Result from hydration
 */
export interface HydrationResult {
  computedValues: ILatticeComputedValues;
  errors: Array<{ entityId: string; attributeKey: string; error: string }>;
  computedAt: Date;
}

// AUTHORIZATION PREDICATES

/**
 * The model's creator, compared through `normalizeId` on both sides.
 *
 * This is the WRITE gate (via `getModelForWrite`) and the owner arm of the read gate, and the
 * subagent Lattice tools in `llm/tools/implementation/lattice` import it so the two surfaces
 * cannot drift apart again.
 */
export function isModelOwner(model: Pick<ILatticeModel, 'userId'>, user: Pick<LatticeModelUser, 'id'>): boolean {
  const ownerId = normalizeId(model.userId);
  // An absent owner id must never match an absent caller id.
  return ownerId !== undefined && ownerId === normalizeId(user.id);
}

/**
 * READ gate: the creator, or a member of the organization the model was created in.
 *
 * Both org ids go through `normalizeId` because they are NOT the same runtime type:
 * `LatticeModel.organizationId` is a String schema path while `req.user.organizationId` is an
 * ObjectId on the hydrated user document, so a raw `===` was always false and silently collapsed
 * org sharing to owner-only everywhere.
 *
 * Write authority stays narrower on purpose - see `getModelForWrite`.
 */
export function canReadModel(model: Pick<ILatticeModel, 'userId' | 'organizationId'>, user: LatticeModelUser): boolean {
  if (isModelOwner(model, user)) return true;

  // Both org ids must be present: a model with no org is private, and an org-less caller is in no
  // org to share through.
  const modelOrgId = normalizeId(model.organizationId);
  return modelOrgId !== undefined && modelOrgId === normalizeId(user.organizationId);
}

// SERVICE IMPLEMENTATION

/**
 * The document every newly created model starts from: ownership, org membership, session/project
 * scoping, and the empty three-layer skeleton.
 *
 * Exported because `lattice_create_model` cannot go through `createModel` - it persists a model
 * together with its entities and rules in a single insert - and hand-rolling its own document is
 * exactly how it came to omit `organizationId` and `sessionId`. A chat-created model was therefore
 * invisible to the session-scoped list and unshareable with the organization no matter what the
 * read gate said. Both paths build from here so they cannot drift apart again.
 */
export function buildNewModel(user: LatticeModelUser, options: CreateModelOptions): Partial<ILatticeModel> {
  const { name, description, modelType = 'custom', sessionId, projectId } = options;
  const now = new Date();

  return {
    name: name.trim(),
    description: description?.trim(),
    modelType,
    userId: user.id,
    organizationId: normalizeId(user.organizationId),
    sessionId,
    projectId,
    data: { entities: [], relationships: [] },
    rules: { rules: [], rulesets: [] },
    views: { views: [] },
    settings: {
      currency: 'USD',
      fiscalYearStart: '01-01',
      periodGrain: 'quarter',
      defaultDecimalPlaces: 2,
      negativeFormat: 'parentheses',
    },
    scenarios: [],
    operations: [],
    operationIndex: -1,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Create a new Lattice model
 */
export async function createModel(
  user: LatticeModelUser,
  options: CreateModelOptions,
  deps: LatticeModelServiceDeps
): Promise<ILatticeModel> {
  if (!options.name || options.name.trim().length === 0) {
    throw new Error('Model name is required');
  }

  return deps.db.latticeModels.create(buildNewModel(user, options));
}

/**
 * Get a model by ID with authorization check
 */
export async function getModel(
  user: LatticeModelUser,
  modelId: string,
  deps: LatticeModelServiceDeps
): Promise<ILatticeModel | null> {
  const model = await deps.db.latticeModels.findById(modelId);

  if (!model) {
    return null;
  }

  return canReadModel(model, user) ? model : null;
}

/**
 * Get a model the caller may MUTATE, or null when they may not.
 *
 * Ownership only, and deliberately NARROWER than `getModel`. `getModel` is the READ gate and admits
 * same-org members by design (a model carries its creator's `organizationId`), but read access is
 * not write access - and every mutator took its authorization from it, so a colleague could rename,
 * re-value, re-rule or delete a model they did not create. Callers that only read keep using `getModel`: `listModels`,
 * `searchModels`, `hydrateModel` (computes derived values and stamps `lastComputedAt`), and
 * `duplicateModel` (reads one model and creates a NEW one owned by the caller).
 *
 * Lattice models carry no share/grant field, so the creator is the only principal that can hold
 * write authority today. If an explicit write grant is ever added, this is the one place to admit
 * it - keeping the check here rather than inlined in six mutators is what makes that a one-line
 * change instead of a six-site audit. The subagent Lattice tools mutate outside this helper (they
 * hit the repository directly) and so import `isModelOwner` to stay on the same rule.
 */
async function getModelForWrite(
  user: LatticeModelUser,
  modelId: string,
  deps: LatticeModelServiceDeps
): Promise<ILatticeModel | null> {
  const model = await getModel(user, modelId, deps);
  if (!model) return null;
  return isModelOwner(model, user) ? model : null;
}

/**
 * List models the caller may read.
 *
 * The session and project branches fetch every model on that session/project and filter with the
 * shared read gate, so org-shared models show up there. The unfiltered branch is owner-only by
 * query (`findByUserId`), which keeps "my models" meaning exactly that; widening it to the whole
 * organization is a product decision, not part of the id-normalization fix.
 */
export async function listModels(
  user: LatticeModelUser,
  options: { limit?: number; skip?: number; sessionId?: string; projectId?: string } = {},
  deps: LatticeModelServiceDeps
): Promise<{ models: ILatticeModel[]; total: number }> {
  let models: ILatticeModel[];

  let total: number;

  if (options.sessionId) {
    models = await deps.db.latticeModels.findBySessionId(options.sessionId);

    // Authorization: only include models owned by the user or in the same organization
    models = models.filter(model => canReadModel(model, user));

    total = models.length;
  } else if (options.projectId) {
    models = await deps.db.latticeModels.findByProjectId(options.projectId);

    // Authorization: only include models owned by the user or in the same organization
    models = models.filter(model => canReadModel(model, user));

    total = models.length;
  } else {
    models = await deps.db.latticeModels.findByUserId(user.id, {
      limit: options.limit,
      skip: options.skip,
    });

    total = await deps.db.latticeModels.count({ userId: user.id });
  }

  return { models, total };
}

/**
 * Update a model
 */
export async function updateModel(
  user: LatticeModelUser,
  modelId: string,
  updates: UpdateModelOptions,
  deps: LatticeModelServiceDeps
): Promise<ILatticeModel | null> {
  // First get the model to check authorization
  const existing = await getModelForWrite(user, modelId, deps);
  if (!existing) {
    return null;
  }

  // Build update data
  const updateData: Partial<ILatticeModel> = {
    id: modelId,
    updatedAt: new Date(),
  };

  if (updates.name !== undefined) {
    updateData.name = updates.name.trim();
  }
  if (updates.description !== undefined) {
    updateData.description = updates.description.trim();
  }
  if (updates.settings) {
    updateData.settings = { ...existing.settings, ...updates.settings };
  }

  return deps.db.latticeModels.update(updateData);
}

/**
 * Delete a model (soft delete)
 */
export async function deleteModel(
  user: LatticeModelUser,
  modelId: string,
  deps: LatticeModelServiceDeps
): Promise<boolean> {
  // First get the model to check authorization
  const existing = await getModelForWrite(user, modelId, deps);
  if (!existing) {
    return false;
  }

  await deps.db.latticeModels.delete(modelId);
  return true;
}

/**
 * Add an entity to a model
 */
export async function addEntity(
  user: LatticeModelUser,
  modelId: string,
  entity: Omit<ILatticeEntity, 'createdAt' | 'updatedAt'>,
  deps: LatticeModelServiceDeps
): Promise<ILatticeModel | null> {
  const model = await getModelForWrite(user, modelId, deps);
  if (!model) {
    return null;
  }

  // Check for duplicate entity ID
  if (model.data.entities.some(e => e.id === entity.id)) {
    throw new Error(`Entity with ID "${entity.id}" already exists`);
  }

  // Add entity
  const now = new Date();
  const newEntity: ILatticeEntity = {
    ...entity,
    createdAt: now,
    updatedAt: now,
  };

  // Record operation for undo/redo
  const operation: ILatticeOperation = {
    id: `op_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
    type: 'CREATE_ENTITY',
    timestamp: now,
    data: { entity: newEntity },
    inverse: { entityId: entity.id },
    description: `Added entity "${entity.name}"`,
  };

  // Update model
  const updatedModel: Partial<ILatticeModel> = {
    id: modelId,
    data: {
      ...model.data,
      entities: [...model.data.entities, newEntity],
    },
    operations: [...model.operations.slice(0, model.operationIndex + 1), operation],
    operationIndex: model.operationIndex + 1,
    updatedAt: now,
  };

  return deps.db.latticeModels.update(updatedModel);
}

/**
 * Set a value on an entity
 */
export async function setValue(
  user: LatticeModelUser,
  modelId: string,
  entityId: string,
  attributeKey: string,
  value: PrimitiveValue,
  deps: LatticeModelServiceDeps
): Promise<ILatticeModel | null> {
  const model = await getModelForWrite(user, modelId, deps);
  if (!model) {
    return null;
  }

  // Find entity
  const entityIndex = model.data.entities.findIndex(e => e.id === entityId);
  if (entityIndex === -1) {
    throw new Error(`Entity "${entityId}" not found`);
  }

  const entity = model.data.entities[entityIndex];
  const now = new Date();

  // Find or create attribute
  const attrIndex = entity.attributes.findIndex(a => a.key === attributeKey);
  const oldValue = attrIndex >= 0 ? entity.attributes[attrIndex].value : null;

  const updatedAttributes = [...entity.attributes];
  if (attrIndex >= 0) {
    updatedAttributes[attrIndex] = {
      ...updatedAttributes[attrIndex],
      value,
      isComputed: false, // User-set values are not computed
    };
  } else {
    // Infer dataType from the actual primitive type of the value
    let dataType: 'number' | 'string' | 'boolean' = 'string';
    if (value !== null && value !== undefined) {
      const primitiveType = typeof value;
      if (primitiveType === 'number' || primitiveType === 'boolean') {
        dataType = primitiveType;
      }
    }

    updatedAttributes.push({
      key: attributeKey,
      value,
      dataType,
      isComputed: false,
    });
  }

  // Update entity
  const updatedEntity: ILatticeEntity = {
    ...entity,
    attributes: updatedAttributes,
    updatedAt: now,
  };

  // Record operation
  const operation: ILatticeOperation = {
    id: `op_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
    type: 'SET_VALUE',
    timestamp: now,
    data: { entityId, attributeKey, value },
    inverse: { entityId, attributeKey, value: oldValue },
    description: `Set ${entity.name}.${attributeKey} = ${value}`,
  };

  // Build updated entities array
  const updatedEntities = [...model.data.entities];
  updatedEntities[entityIndex] = updatedEntity;

  // Update model
  const updatedModel: Partial<ILatticeModel> = {
    id: modelId,
    data: {
      ...model.data,
      entities: updatedEntities,
    },
    operations: [...model.operations.slice(0, model.operationIndex + 1), operation],
    operationIndex: model.operationIndex + 1,
    updatedAt: now,
  };

  return deps.db.latticeModels.update(updatedModel);
}

/**
 * Add a rule to a model
 */
export async function addRule(
  user: LatticeModelUser,
  modelId: string,
  rule: Omit<ILatticeRule, 'createdAt' | 'updatedAt'>,
  deps: LatticeModelServiceDeps
): Promise<ILatticeModel | null> {
  const model = await getModelForWrite(user, modelId, deps);
  if (!model) {
    return null;
  }

  // Check for duplicate rule ID
  if (model.rules.rules.some(r => r.id === rule.id)) {
    throw new Error(`Rule with ID "${rule.id}" already exists`);
  }

  const now = new Date();
  const newRule: ILatticeRule = {
    ...rule,
    createdAt: now,
    updatedAt: now,
  };

  // Record operation
  const operation: ILatticeOperation = {
    id: `op_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
    type: 'CREATE_RULE',
    timestamp: now,
    data: { rule: newRule },
    inverse: { ruleId: rule.id },
    description: `Added rule "${rule.name}"`,
  };

  // Update model
  const updatedModel: Partial<ILatticeModel> = {
    id: modelId,
    rules: {
      ...model.rules,
      rules: [...model.rules.rules, newRule],
    },
    operations: [...model.operations.slice(0, model.operationIndex + 1), operation],
    operationIndex: model.operationIndex + 1,
    updatedAt: now,
  };

  return deps.db.latticeModels.update(updatedModel);
}

/**
 * Hydrate a model - compute all derived values via the HydrationEngine
 */
export async function hydrateModel(
  user: LatticeModelUser,
  modelId: string,
  deps: LatticeModelServiceDeps,
  options?: { scenarioId?: string }
): Promise<HydrationResult> {
  // getModel, not getModelForWrite: hydration COMPUTES and returns derived values for a model the
  // caller can read (POST /api/lattice/models/[id]/hydrate is how the UI renders them). Its only
  // write is the `lastComputedAt` freshness stamp below, which is derived bookkeeping, not user
  // content - narrowing this to the owner would blank the computed view for same-org colleagues
  // who can already read the model.
  const model = await getModel(user, modelId, deps);
  if (!model) {
    throw new Error('Model not found');
  }

  // Create engine
  const engine = new HydrationEngine();

  // Find scenario if specified
  let scenario;
  if (options?.scenarioId) {
    scenario = model.scenarios.find(s => s.id === options.scenarioId);
  }

  // Run hydration
  const result = engine.hydrate(model.data, model.rules, { scenario });

  // Update model with lastComputedAt
  await deps.db.latticeModels.update({
    id: modelId,
    lastComputedAt: new Date(),
  });

  // Map errors to simpler format
  const errors = result.errors.map(e => ({
    entityId: e.context?.relatedEntities?.[0] || 'unknown',
    attributeKey: e.context?.input || 'unknown',
    error: e.message,
  }));

  return {
    computedValues: result.values,
    errors,
    computedAt: new Date(),
  };
}

/**
 * Search models by name/description
 */
export async function searchModels(
  user: LatticeModelUser,
  query: string,
  deps: LatticeModelServiceDeps,
  options?: { limit?: number }
): Promise<ILatticeModel[]> {
  return deps.db.latticeModels.search(user.id, query, options?.limit ?? 20);
}

/**
 * Duplicate a model
 */
export async function duplicateModel(
  user: LatticeModelUser,
  modelId: string,
  newName: string,
  deps: LatticeModelServiceDeps
): Promise<ILatticeModel | null> {
  const model = await getModel(user, modelId, deps);
  if (!model) {
    return null;
  }

  // Create a copy with new name and cleared history
  const now = new Date();
  const copyData: Partial<ILatticeModel> = {
    name: newName,
    description: model.description ? `Copy of ${model.description}` : undefined,
    modelType: model.modelType,
    userId: user.id,
    organizationId: normalizeId(user.organizationId),
    data: structuredClone(model.data),
    rules: structuredClone(model.rules),
    views: structuredClone(model.views),
    settings: { ...model.settings },
    scenarios: structuredClone(model.scenarios),
    operations: [], // Clear history for copy
    operationIndex: -1,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };

  return deps.db.latticeModels.create(copyData);
}
