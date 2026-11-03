import { describe, expect, it } from 'vitest';
import { mongoose } from '@bike4mind/database';
// Registered outside the `@bike4mind/database` barrel, so they register only when imported.
import '@bike4mind/server-utils/models/Subscription';
import '@server/models/UserSubscription';
import { DATA_HOLDER_REGISTRY } from './registry';
import { listSchemaPaths, looksLikeUserReference, schemaDeclaresPath } from './schemaPaths';
import type { DataHolder, UserReference } from './types';

const registeredModels = mongoose.modelNames().sort();
const classifiedModels = Object.keys(DATA_HOLDER_REGISTRY).sort();

function referencePaths(reference: UserReference): string[] {
  return [
    reference.path,
    ...Object.keys(reference.where ?? {}),
    ...(reference.action === 'anonymize' ? (reference.alsoRedact ?? []) : []),
  ];
}

function declaredPathsOf(holder: DataHolder): string[] {
  switch (holder.kind) {
    case 'subject':
      return [...holder.secretPaths];
    case 'holder':
      return [
        ...holder.references.flatMap(referencePaths),
        ...(holder.secretPaths ?? []),
        ...(holder.unrelatedPaths ?? []),
      ];
    case 'viaParent':
      return [
        holder.foreignKey,
        ...(holder.attribution ?? []).flatMap(referencePaths),
        ...(holder.secretPaths ?? []),
        ...(holder.unrelatedPaths ?? []),
      ];
    case 'pseudonymous':
    case 'noUserData':
      return [...(holder.unrelatedPaths ?? [])];
    case 'discriminator':
      return [];
  }
}

function acknowledgedPathsOf(holder: DataHolder): Set<string> {
  switch (holder.kind) {
    case 'holder':
      return new Set([...holder.references.map(reference => reference.path), ...(holder.unrelatedPaths ?? [])]);
    case 'viaParent':
      return new Set([
        holder.foreignKey,
        ...(holder.attribution ?? []).map(reference => reference.path),
        ...(holder.unrelatedPaths ?? []),
      ]);
    default:
      return new Set(declaredPathsOf(holder));
  }
}

function baseModelNameOf(modelName: string): string | undefined {
  return (mongoose.model(modelName) as { baseModelName?: string }).baseModelName;
}

describe('data holder registry', () => {
  it('sanity: the model barrels registered a realistic number of models', () => {
    // Guards the tests below against passing vacuously if the side-effect imports stop registering.
    expect(registeredModels.length).toBeGreaterThan(200);
  });

  it('classifies every registered model', () => {
    const unclassified = registeredModels.filter(name => !(name in DATA_HOLDER_REGISTRY));
    expect(
      unclassified,
      'Classify these models in apps/client/server/dataSubject/registry so data subject exports and erasure cover them'
    ).toEqual([]);
  });

  it('classifies only models that exist', () => {
    const stale = classifiedModels.filter(name => !registeredModels.includes(name));
    expect(stale, 'These registry entries name models that are no longer registered').toEqual([]);
  });

  it('classifies exactly one model as the subject, and it is User', () => {
    const subjects = classifiedModels.filter(name => DATA_HOLDER_REGISTRY[name].kind === 'subject');
    expect(subjects).toEqual(['User']);
  });

  it.each(classifiedModels.filter(name => registeredModels.includes(name)))(
    '%s: every path the registry names is declared by the schema',
    modelName => {
      const { schema } = mongoose.model(modelName);
      const undeclared = declaredPathsOf(DATA_HOLDER_REGISTRY[modelName]).filter(
        path => !schemaDeclaresPath(schema, path)
      );
      expect(undeclared).toEqual([]);
    }
  );

  it('classifies a model as a discriminator exactly when Mongoose registered it as one', () => {
    const mismatched = registeredModels.filter(name => {
      const holder = DATA_HOLDER_REGISTRY[name];
      const base = baseModelNameOf(name);
      if (holder?.kind === 'discriminator') return holder.base !== base;
      return base !== undefined;
    });
    expect(mismatched).toEqual([]);
  });

  it.each(
    classifiedModels.filter(
      name => registeredModels.includes(name) && name !== 'User' && DATA_HOLDER_REGISTRY[name].kind !== 'discriminator'
    )
  )('%s: every path that looks like a user reference is classified', modelName => {
    const holder = DATA_HOLDER_REGISTRY[modelName];
    const acknowledged = acknowledgedPathsOf(holder);
    const unclassified = listSchemaPaths(mongoose.model(modelName).schema).filter(
      path => looksLikeUserReference(path) && !acknowledged.has(path)
    );
    expect(
      unclassified,
      'Add each path to the entry as a reference, or to unrelatedPaths if it does not identify a person'
    ).toEqual([]);
  });

  it.each(
    classifiedModels.flatMap(name => {
      const holder = DATA_HOLDER_REGISTRY[name];
      return holder.kind === 'viaParent' ? [[name, holder.parent, holder.parentKey ?? '_id'] as const] : [];
    })
  )('%s: its parent %s is itself a holder and declares %s', (_modelName, parent, parentKey) => {
    expect(DATA_HOLDER_REGISTRY[parent]?.kind).toMatch(/^(holder|viaParent)$/);
    expect(schemaDeclaresPath(mongoose.model(parent).schema, parentKey)).toBe(true);
  });

  it.each(
    classifiedModels.flatMap(name => {
      const holder = DATA_HOLDER_REGISTRY[name];
      return holder.kind === 'holder'
        ? holder.references.filter(reference => reference.action === 'pullFromArray').map(r => [name, r.path] as const)
        : [];
    })
  )('%s: pullFromArray path %s is an array or a key inside one', (modelName, path) => {
    const { schema } = mongoose.model(modelName);
    const isArray = (candidate: string) => /Array/.test(schema.path(candidate)?.instance ?? '');
    const parentPath = path.includes('.') ? path.slice(0, path.lastIndexOf('.')) : '';
    expect(isArray(path) || (parentPath !== '' && isArray(parentPath))).toBe(true);
  });
});
