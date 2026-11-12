import { AsyncLocalStorage } from 'node:async_hooks';
import mongoose, { type Schema } from 'mongoose';
import { ForbiddenError, ORG_MEMBERSHIP_ACL_PERMISSIONS } from '@bike4mind/common';

type Scope = {
  principal: () => string | undefined;
  serviceOrganization?: () => string | undefined;
  blocked: Map<string, Promise<string[]>>;
  parents: Map<string, Promise<boolean>>;
};

const context = new AsyncLocalStorage<Scope>();

export function withOrganizationMfaContext<T>(
  principal: () => string | undefined,
  operation: () => T,
  serviceOrganization?: () => string | undefined
): T {
  return context.run({ principal, serviceOrganization, blocked: new Map(), parents: new Map() }, operation);
}

export function isOrganizationMfaServiceContext(userId: string, organizationId: string): boolean {
  const scope = context.getStore();
  return !!scope && scope.principal() === userId && scope.serviceOrganization?.() === organizationId;
}

async function blockedOrganizations(scope: Scope): Promise<string[]> {
  const userId = scope.principal();
  if (!userId) return [];
  const serviceOrganization = scope.serviceOrganization?.();
  const key = `${userId ?? ''}:${serviceOrganization ?? ''}`;
  const cached = scope.blocked.get(key);
  if (cached) return cached;
  const read = (async () => {
    const db = mongoose.connection.db;
    if (!db) throw new Error('Organization policy database unavailable');
    const user =
      userId && mongoose.isObjectIdOrHexString(userId)
        ? await db
            .collection('users')
            .findOne(
              { _id: new mongoose.Types.ObjectId(userId) },
              { projection: { 'mfa.totpEnabled': 1, isSystem: 1, isAdmin: 1, serviceAccountOrganizationId: 1 } }
            )
        : null;
    if (user?.mfa?.totpEnabled === true) return [];
    const orgs = await db
      .collection('organizations')
      .find(
        {
          'mfaPolicy.required': true,
          deletedAt: null,
          $or: [
            { userId },
            { users: { $elemMatch: { userId, permissions: { $in: [...ORG_MEMBERSHIP_ACL_PERMISSIONS] } } } },
            ...(user?.isSystem === true && mongoose.isObjectIdOrHexString(user.serviceAccountOrganizationId)
              ? [{ _id: new mongoose.Types.ObjectId(user.serviceAccountOrganizationId) }]
              : []),
          ],
        },
        { projection: { 'mfaPolicy.enforceAfter': 1 } }
      )
      .toArray();
    return orgs
      .filter(org => {
        if (
          serviceOrganization === String(org._id) &&
          user?.isSystem === true &&
          user.isAdmin !== true &&
          user.serviceAccountOrganizationId === serviceOrganization
        )
          return false;
        const deadline = org.mfaPolicy?.enforceAfter;
        return (
          !deadline || !Number.isFinite(new Date(deadline).getTime()) || new Date(deadline).getTime() <= Date.now()
        );
      })
      .map(org => String(org._id));
  })();
  scope.blocked.set(key, read);
  return read;
}

const RESOURCE_MODELS = new Set([
  'SessionModel',
  'Project',
  'FabFile',
  'FabFileChunk',
  'Artifact',
  'ArtifactVersion',
  'ArtifactContent',
  'PublishedArtifact',
  'Quest',
  'QuestMasterPlan',
  'DataLake',
  'DataLakeBatch',
  'Agent',
  'Skill',
  'ToolModel',
  'ResearchTask',
  'LatticeModel',
  'SkillBundle',
  'SkillListing',
  'WorkItem',
  'McpConnection',
]);

const PARENT_FIELDS = [
  ['sessionId', 'SessionModel'],
  ['projectId', 'Project'],
  ['dataLakeId', 'DataLake'],
  ['artifactId', 'Artifact'],
  ['fabFileId', 'FabFile'],
  ['source.sessionId', 'SessionModel'],
  ['source.artifactId', 'Artifact'],
  ['source.fabFileId', 'FabFile'],
] as const;

function isResource(schema: Schema, modelName: string): boolean {
  return RESOURCE_MODELS.has(modelName) || PARENT_FIELDS.some(([field]) => !!schema.path(field));
}

async function parentDenied(
  scope: Scope,
  modelName: string,
  value: unknown,
  blocked: string[],
  ancestors: string[]
): Promise<boolean> {
  if (value == null || ancestors.includes(modelName)) return false;
  const parent = mongoose.models[modelName];
  if (!parent) throw new Error(`Organization policy parent model unavailable: ${modelName}`);
  const key = `${scope.principal() ?? ''}:${blocked.join(',')}:${modelName}:${String(value)}:${ancestors.join(',')}`;
  let denied = scope.parents.get(key);
  if (!denied) {
    denied = (async () => {
      const db = mongoose.connection.db;
      if (!db) throw new Error('Organization policy database unavailable');
      const id = String(value);
      const identifiers: Record<string, unknown>[] = [];
      if (mongoose.isObjectIdOrHexString(id)) identifiers.push({ _id: new mongoose.Types.ObjectId(id) });
      if (parent.schema.path('_id')?.instance === 'String') identifiers.push({ _id: id });
      if (parent.schema.path('id')) identifiers.push({ id });
      if (!identifiers.length) return false;
      const rows = db
        .collection(parent.collection.collectionName)
        .find({ $or: identifiers }, { projection: bindingProjection(parent.schema), batchSize: 1, limit: 2 });
      try {
        for await (const row of rows) {
          if (await documentDenied(scope, row, parent.schema, modelName, blocked, ancestors)) return true;
        }
      } finally {
        await rows.close();
      }
      return false;
    })();
    if (scope.parents.size >= 256) scope.parents.delete(scope.parents.keys().next().value!);
    scope.parents.set(key, denied);
  }
  return denied;
}

function bindingProjection(schema: Schema): Record<string, 1> {
  return Object.fromEntries(
    ['organizationId', 'tier', 'scopeId', ...PARENT_FIELDS.map(([field]) => field)]
      .filter(field => !!schema.path(field))
      .map(field => [field, 1])
  );
}

function bindingValue(document: Record<string, unknown>, field: string): unknown {
  return field.split('.').reduce<unknown>((value, key) => {
    return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
  }, document);
}

async function documentDenied(
  scope: Scope,
  document: Record<string, unknown>,
  schema: Schema,
  modelName: string,
  blocked: string[],
  ancestors: string[]
): Promise<boolean> {
  if (blocked.includes(String(document.organizationId))) return true;
  const path = [...ancestors, modelName];
  for (const [field, model] of PARENT_FIELDS) {
    if (schema.path(field) && (await parentDenied(scope, model, bindingValue(document, field), blocked, path)))
      return true;
  }
  if (modelName === 'PublishedArtifact') {
    if (document.tier === 'organization' && blocked.includes(String(document.scopeId))) return true;
    if (document.tier === 'project' && (await parentDenied(scope, 'Project', document.scopeId, blocked, path)))
      return true;
  }
  return false;
}

export async function organizationMfaResourceFilter(
  schema: Schema,
  modelName: string,
  candidates: Record<string, unknown> = {}
): Promise<Record<string, unknown> | null> {
  const scope = context.getStore();
  if (!scope || !isResource(schema, modelName)) return null;
  const blocked = await blockedOrganizations(scope);
  if (!blocked.length) return null;
  return resourceFilter(scope, schema, modelName, blocked, candidates);
}

async function resourceFilter(
  scope: Scope,
  schema: Schema,
  modelName: string,
  blocked: string[],
  candidates: Record<string, unknown>
): Promise<Record<string, unknown> | null> {
  const clauses: Record<string, unknown>[] = [];
  if (schema.path('organizationId')) clauses.push({ organizationId: { $nin: blocked } });
  if (modelName === 'PublishedArtifact') {
    clauses.push({ $nor: [{ tier: 'organization', scopeId: { $in: blocked } }] });
  }
  if (PARENT_FIELDS.some(([field]) => !!schema.path(field)) || modelName === 'PublishedArtifact') {
    const model = mongoose.models[modelName];
    const db = mongoose.connection.db;
    if (!db || !model) throw new Error('Organization policy database unavailable');
    const query = model.find(candidates);
    query.cast(model);
    const rows = db.collection(model.collection.collectionName).find(query.getFilter() as Record<string, unknown>, {
      projection: bindingProjection(schema),
      batchSize: 100,
    });
    const denied: unknown[] = [];
    try {
      for await (const row of rows) {
        if (await documentDenied(scope, row, schema, modelName, blocked, [])) denied.push(row._id);
      }
    } finally {
      await rows.close();
    }
    clauses.push({ _id: { $nin: denied } });
  }
  return clauses.length ? { $and: clauses } : null;
}

async function assertDocumentAllowed(
  document: Pick<mongoose.Document<unknown>, 'get'>,
  schema: Schema,
  modelName: string
): Promise<void> {
  const scope = context.getStore();
  if (!scope || !isResource(schema, modelName)) return;
  const blocked = await blockedOrganizations(scope);
  if (!blocked.length) return;
  const fields = Object.fromEntries(Object.keys(bindingProjection(schema)).map(field => [field, document.get(field)]));
  fields.source = document.get('source');
  if (await documentDenied(scope, fields, schema, modelName, blocked, [])) {
    throw new ForbiddenError('Organization requires MFA enrollment');
  }
}

function assertBindingUpdate(update: mongoose.UpdateQuery<unknown>): void {
  const protectedFields = ['organizationId', 'tier', 'scopeId', ...PARENT_FIELDS.map(([field]) => field)];
  for (const [operator, fields] of Object.entries(update)) {
    if (!operator.startsWith('$') || operator === '$set' || operator === '$setOnInsert' || operator === '$unset')
      continue;
    if (!fields || typeof fields !== 'object') continue;
    const paths = [
      ...Object.keys(fields),
      ...(operator === '$rename'
        ? Object.values(fields).filter((value): value is string => typeof value === 'string')
        : []),
    ];
    if (
      paths.some(path =>
        protectedFields.some(field => path === field || path.startsWith(`${field}.`) || field.startsWith(`${path}.`))
      )
    ) {
      throw new ForbiddenError('Organization MFA requires explicit resource binding updates');
    }
  }
}

async function guardPipeline(
  pipeline: mongoose.PipelineStage[],
  schema: Schema,
  modelName: string,
  filterSource = true
): Promise<void> {
  for (const stage of pipeline) {
    if ('$lookup' in stage || '$unionWith' in stage) {
      const join = '$lookup' in stage ? stage.$lookup : stage.$unionWith;
      const collection = typeof join === 'string' ? join : 'from' in join ? join.from : join.coll;
      const model = Object.values(mongoose.models).find(
        candidate => candidate.collection.collectionName === collection
      );
      if (!model) continue;
      const nested = typeof join === 'string' ? [] : (join.pipeline ?? []);
      await guardPipeline(nested, model.schema, model.modelName);
      if ('$lookup' in stage) stage.$lookup.pipeline = nested;
      else stage.$unionWith = { coll: collection, pipeline: nested };
    }
    if ('$facet' in stage) {
      for (const nested of Object.values(stage.$facet)) await guardPipeline(nested, schema, modelName, false);
    }
  }
  if (!filterSource) return;
  const leadingMatch =
    pipeline[0] && '$match' in pipeline[0] && !JSON.stringify(pipeline[0]).includes('$$') ? pipeline[0].$match : {};
  const filter = await organizationMfaResourceFilter(schema, modelName, leadingMatch);
  if (!filter) return;
  const first = pipeline[0];
  pipeline.splice(first && ('$search' in first || '$vectorSearch' in first || '$geoNear' in first) ? 1 : 0, 0, {
    $match: filter,
  });
}

export function organizationMfaResourcePlugin(schema: Schema): void {
  schema.pre('save', async function () {
    const modelName = (this.constructor as mongoose.Model<unknown>).modelName;
    await assertDocumentAllowed(this, schema, modelName);
    const filter = await organizationMfaResourceFilter(schema, modelName, { _id: this._id });
    if (!this.isNew && filter && !(await this.$model().exists({ $and: [{ _id: this._id }, filter] }))) {
      throw new ForbiddenError('Organization requires MFA enrollment');
    }
  });
  schema.pre(
    [
      'find',
      'findOne',
      'countDocuments',
      'distinct',
      'updateOne',
      'updateMany',
      'findOneAndUpdate',
      'replaceOne',
      'findOneAndReplace',
      'deleteOne',
      'deleteMany',
      'findOneAndDelete',
    ],
    async function () {
      const filter = await organizationMfaResourceFilter(schema, this.model.modelName, this.getFilter());
      if (!filter) return;
      const update = this.getUpdate();
      if (Array.isArray(update)) throw new ForbiddenError('Organization MFA requires a document update');
      if (update) {
        assertBindingUpdate(update);
        await assertDocumentAllowed(
          new this.model({ ...update, ...update.$set, ...update.$setOnInsert }),
          schema,
          this.model.modelName
        );
        if (this.getOptions().upsert)
          await assertDocumentAllowed(new this.model(this.getFilter()), schema, this.model.modelName);
      }
      this.setQuery({ $and: [this.getFilter(), filter] });
    }
  );
  schema.pre('insertMany', async function (next, documents) {
    try {
      for (const document of documents) await assertDocumentAllowed(new this(document), schema, this.modelName);
      next();
    } catch (error) {
      next(error as Error);
    }
  });
  schema.pre('bulkWrite', async function (next, operations) {
    try {
      const candidates = operations.flatMap(operation => {
        if ('insertOne' in operation) return [];
        const command = Object.values(operation)[0] as { filter: Record<string, unknown> };
        return [command.filter];
      });
      const filter = await organizationMfaResourceFilter(
        schema,
        this.modelName,
        candidates.length ? { $or: candidates } : { _id: { $in: [] } }
      );
      if (filter) {
        for (const operation of operations) {
          if ('insertOne' in operation) {
            await assertDocumentAllowed(new this(operation.insertOne.document), schema, this.modelName);
            continue;
          }
          const command =
            'updateOne' in operation
              ? operation.updateOne
              : 'updateMany' in operation
                ? operation.updateMany
                : 'replaceOne' in operation
                  ? operation.replaceOne
                  : 'deleteOne' in operation
                    ? operation.deleteOne
                    : operation.deleteMany;
          if ('update' in command) {
            const update = command.update;
            if (!update || typeof update !== 'object' || Array.isArray(update))
              throw new ForbiddenError('Organization MFA requires a document update');
            const fields = update as mongoose.UpdateQuery<unknown>;
            assertBindingUpdate(fields);
            await assertDocumentAllowed(
              new this({ ...fields, ...fields.$set, ...fields.$setOnInsert }),
              schema,
              this.modelName
            );
          }
          if ('replacement' in command)
            await assertDocumentAllowed(new this(command.replacement), schema, this.modelName);
          if ('upsert' in command && command.upsert)
            await assertDocumentAllowed(new this(command.filter), schema, this.modelName);
          command.filter = { $and: [command.filter, filter] };
        }
      }
      next();
    } catch (error) {
      next(error as Error);
    }
  });
  schema.pre('aggregate', async function () {
    if (!context.getStore()) return;
    await guardPipeline(this.pipeline(), schema, this.model().modelName);
  });
}
