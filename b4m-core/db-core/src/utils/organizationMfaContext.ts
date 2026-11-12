import { AsyncLocalStorage } from 'node:async_hooks';
import mongoose, { type Schema } from 'mongoose';
import { ForbiddenError } from '@bike4mind/common';

type Scope = {
  principal: () => string | undefined;
  serviceOrganization?: () => string | undefined;
  blocked: Map<string, Promise<string[]>>;
  parents: Map<string, Promise<unknown[]>>;
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
              { projection: { 'mfa.totpEnabled': 1, isSystem: 1, isAdmin: 1, orgServiceAccount: 1 } }
            )
        : null;
    if (user?.mfa?.totpEnabled === true) return [];
    const orgs = await db
      .collection('organizations')
      .find({ 'mfaPolicy.required': true, deletedAt: null }, { projection: { 'mfaPolicy.enforceAfter': 1 } })
      .toArray();
    return orgs
      .filter(org => {
        if (
          serviceOrganization === String(org._id) &&
          user?.isSystem === true &&
          user.isAdmin !== true &&
          user.orgServiceAccount?.organizationId === serviceOrganization
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

async function parentIds(scope: Scope, modelName: string, blocked: string[], ancestors: string[]): Promise<unknown[]> {
  if (ancestors.includes(modelName)) return [];
  const parent = mongoose.models[modelName];
  if (!parent) throw new Error(`Organization policy parent model unavailable: ${modelName}`);
  const key = `${scope.principal() ?? ''}:${blocked.join(',')}:${modelName}:${ancestors.join(',')}`;
  let ids = scope.parents.get(key);
  if (!ids) {
    ids = (async () => {
      const db = mongoose.connection.db;
      if (!db) throw new Error('Organization policy database unavailable');
      const filter = await resourceFilter(scope, parent.schema, modelName, blocked, ancestors);
      if (!filter) return [];
      const rows = await db
        .collection(parent.collection.collectionName)
        .find({ $nor: [filter] }, { projection: { _id: 1, id: 1 } })
        .toArray();
      return rows.flatMap(row => [row._id, String(row._id), ...(typeof row.id === 'string' ? [row.id] : [])]);
    })();
    scope.parents.set(key, ids);
  }
  return ids;
}

export async function organizationMfaResourceFilter(
  schema: Schema,
  modelName: string
): Promise<Record<string, unknown> | null> {
  const scope = context.getStore();
  if (!scope || !isResource(schema, modelName)) return null;
  const blocked = await blockedOrganizations(scope);
  if (!blocked.length) return null;
  return resourceFilter(scope, schema, modelName, blocked, []);
}

async function resourceFilter(
  scope: Scope,
  schema: Schema,
  modelName: string,
  blocked: string[],
  ancestors: string[]
): Promise<Record<string, unknown> | null> {
  const clauses: Record<string, unknown>[] = [];
  if (schema.path('organizationId')) clauses.push({ organizationId: { $nin: blocked } });
  for (const [field, model] of PARENT_FIELDS) {
    if (!schema.path(field)) continue;
    clauses.push({ [field]: { $nin: await parentIds(scope, model, blocked, [...ancestors, modelName]) } });
  }
  if (modelName === 'PublishedArtifact') {
    clauses.push({
      $nor: [
        { tier: 'organization', scopeId: { $in: blocked } },
        { tier: 'project', scopeId: { $in: await parentIds(scope, 'Project', blocked, [...ancestors, modelName]) } },
      ],
    });
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
  const denied = () => {
    throw new ForbiddenError('Organization requires MFA enrollment');
  };
  if (blocked.includes(String(document.get('organizationId')))) denied();
  for (const [field, model] of PARENT_FIELDS) {
    const value: unknown = document.get(field);
    if (!schema.path(field) || value == null) continue;
    const ids = await parentIds(scope, model, blocked, [modelName]);
    if (ids.some(id => String(id) === String(value))) denied();
  }
  if (modelName === 'PublishedArtifact') {
    const tier: unknown = document.get('tier');
    const scopeId = String(document.get('scopeId'));
    if (tier === 'organization' && blocked.includes(scopeId)) denied();
    if (
      tier === 'project' &&
      (await parentIds(scope, 'Project', blocked, [modelName])).some(id => String(id) === scopeId)
    )
      denied();
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
  const filter = await organizationMfaResourceFilter(schema, modelName);
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
    const filter = await organizationMfaResourceFilter(schema, modelName);
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
      const filter = await organizationMfaResourceFilter(schema, this.model.modelName);
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
      const filter = await organizationMfaResourceFilter(schema, this.modelName);
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
