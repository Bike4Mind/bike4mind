import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mongoose } from '@bike4mind/database';
// Registered outside the `@bike4mind/database` barrel, so they register only when imported.
import '@bike4mind/server-utils/models/Subscription';
import '@server/models/UserSubscription';
import { DATA_HOLDER_REGISTRY, findUnclassifiedModels } from './registry';
import {
  listSchemaLeaves,
  listSchemaPaths,
  looksLikeSecret,
  looksLikeUserReference,
  schemaDeclaresPath,
} from './schemaPaths';
import type { DataHolder, UserReference } from './types';

const registeredModels = mongoose.modelNames().sort();
const classifiedModels = Object.keys(DATA_HOLDER_REGISTRY).sort();

function referencePaths(reference: UserReference): string[] {
  return [reference.path, ...Object.keys(reference.where ?? {}), ...alsoRedactOf(reference)];
}

function alsoRedactOf(reference: UserReference): readonly string[] {
  return reference.action === 'anonymize' || reference.action === 'retain' ? (reference.alsoRedact ?? []) : [];
}

function referencesOf(holder: DataHolder): readonly UserReference[] {
  switch (holder.kind) {
    case 'subject':
    case 'holder':
      return holder.references;
    case 'viaParent':
      return holder.attribution ?? [];
    default:
      return [];
  }
}

function declaredPathsOf(holder: DataHolder): string[] {
  switch (holder.kind) {
    case 'subject':
      return [...holder.references.flatMap(referencePaths), ...holder.secretPaths, ...(holder.unrelatedPaths ?? [])];
    case 'holder':
      return [
        ...holder.references.flatMap(referencePaths),
        ...(holder.secretPaths ?? []),
        ...(holder.unrelatedPaths ?? []),
        ...Object.keys(holder.unmatchedPaths ?? {}),
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

/** Paths the entry has said how to erase, or said are not a person. A secret is neither. */
function acknowledgedPathsOf(holder: DataHolder): Set<string> {
  const handled = referencesOf(holder).flatMap(reference => [reference.path, ...alsoRedactOf(reference)]);
  switch (holder.kind) {
    case 'holder':
      return new Set([...handled, ...(holder.unrelatedPaths ?? []), ...Object.keys(holder.unmatchedPaths ?? {})]);
    case 'viaParent':
      return new Set([holder.foreignKey, ...handled, ...(holder.unrelatedPaths ?? [])]);
    case 'subject':
      return new Set([...handled, ...(holder.unrelatedPaths ?? [])]);
    case 'pseudonymous':
    case 'noUserData':
      return new Set(holder.unrelatedPaths ?? []);
    case 'discriminator':
      return new Set();
  }
}

/** Paths that name a person by their field name or by a declared `ref: 'User'`. */
function userReferenceLikePaths(schema: mongoose.Schema): string[] {
  return listSchemaLeaves(schema)
    .filter(leaf => leaf.refsUser || looksLikeUserReference(leaf.path))
    .map(leaf => leaf.path);
}

/** The kinds whose documents an export can include; see the export rules in types.ts. */
function isExported(holder: DataHolder): boolean {
  return holder.kind === 'subject' || holder.kind === 'holder' || holder.kind === 'viaParent';
}

function baseModelNameOf(modelName: string): string | undefined {
  return (mongoose.model(modelName) as { baseModelName?: string }).baseModelName;
}

// `where` targets whose schema declares no enum, so the value cannot be checked against it.
const WHERE_WITHOUT_ENUM: readonly string[] = [
  // Written as a Mongoose model name (`User.modelName`) by ActivityRepository callers.
  'Activity.ownerType',
  // Plain strings; every writer passes CreditHolderType, whose user member is 'User'.
  'CreditTransaction.recipientType',
  'CreditTransaction.senderType',
  // No writer in the repo; typed string, mirrors CreditTransaction.ownerType (CreditHolderType).
  'FailedRefund.ownerType',
];

describe('data holder registry', () => {
  it('sanity: the model barrels registered a realistic number of models', () => {
    // Guards the tests below against passing vacuously if the side-effect imports stop registering.
    expect(registeredModels.length).toBeGreaterThan(200);
  });

  it('classifies every registered model', () => {
    const unclassified = findUnclassifiedModels(registeredModels);
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
    const acknowledged = acknowledgedPathsOf(DATA_HOLDER_REGISTRY[modelName]);
    const unclassified = userReferenceLikePaths(mongoose.model(modelName).schema).filter(
      path => !acknowledged.has(path)
    );
    expect(
      unclassified,
      'Add each path to the entry as a reference, or to unrelatedPaths if it does not identify a person'
    ).toEqual([]);
  });

  it.each(classifiedModels.filter(name => registeredModels.includes(name) && isExported(DATA_HOLDER_REGISTRY[name])))(
    '%s: every path that looks like a secret is in secretPaths',
    modelName => {
      const holder = DATA_HOLDER_REGISTRY[modelName];
      const secrets = new Set('secretPaths' in holder ? (holder.secretPaths ?? []) : []);
      const unlisted = listSchemaLeaves(mongoose.model(modelName).schema)
        .filter(leaf => looksLikeSecret(leaf) && !secrets.has(leaf.path))
        .map(leaf => leaf.path);
      expect(unlisted, 'Add each path to secretPaths so a data subject export never includes it').toEqual([]);
    }
  );

  it('User: every field that references another user is a subject reference', () => {
    // The person's own fields are covered by deleting the User document; a field naming another
    // user is the person recorded on someone else's account, which outlives this erasure.
    const acknowledged = acknowledgedPathsOf(DATA_HOLDER_REGISTRY.User);
    const unclassified = listSchemaLeaves(mongoose.model('User').schema)
      .filter(leaf => leaf.refsUser && !acknowledged.has(leaf.path))
      .map(leaf => leaf.path);
    expect(unclassified).toEqual([]);
  });

  it.each(
    classifiedModels.flatMap(name => {
      const holder = DATA_HOLDER_REGISTRY[name];
      return holder.kind === 'discriminator' ? [[name, holder.base] as const] : [];
    })
  )('%s: adds no user-reference field its base %s does not already cover', (modelName, base) => {
    // A discriminator shares its base's collection and entry, so a field only it declares is
    // invisible to the base entry's checks.
    const basePaths = new Set(listSchemaPaths(mongoose.model(base).schema));
    const added = userReferenceLikePaths(mongoose.model(modelName).schema).filter(path => !basePaths.has(path));
    expect(added).toEqual([]);
  });

  it.each(
    classifiedModels.flatMap(name =>
      referencesOf(DATA_HOLDER_REGISTRY[name]).flatMap(reference =>
        Object.entries(reference.where ?? {}).map(([key, value]) => [name, key, value] as const)
      )
    )
  )('%s: where %s = %s is a value the schema allows', (modelName, key, value) => {
    const enumValues = (mongoose.model(modelName).schema.path(key) as { enumValues?: unknown[] } | undefined)
      ?.enumValues;
    if (value === null) return;
    if (!enumValues?.length) {
      expect(WHERE_WITHOUT_ENUM, `${modelName}.${key} has no enum to check ${value} against`).toContain(
        `${modelName}.${key}`
      );
      return;
    }
    expect(enumValues).toContain(value);
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
      return referencesOf(DATA_HOLDER_REGISTRY[name])
        .filter(reference => reference.action === 'pullFromArray')
        .map(reference => [name, reference.path] as const);
    })
  )('%s: pullFromArray path %s is an array or a key inside one', (modelName, path) => {
    const { schema } = mongoose.model(modelName);
    const isArray = (candidate: string) => /Array/.test(schema.path(candidate)?.instance ?? '');
    const parentPath = path.includes('.') ? path.slice(0, path.lastIndexOf('.')) : '';
    expect(isArray(path) || (parentPath !== '' && isArray(parentPath))).toBe(true);
  });

  it.each(
    classifiedModels.flatMap(name => {
      const holder = DATA_HOLDER_REGISTRY[name];
      return holder.kind === 'holder' ? (holder.beforeErasure ?? []).map(fn => [name, fn] as const) : [];
    })
  )('%s: beforeErasure function %s is exported from the repo', (_modelName, functionName) => {
    const repoRoot = path.resolve(__dirname, '../../../..');
    const pattern = `export (async )?function ${functionName}([^A-Za-z0-9_]|$)`;
    const matches = execFileSync('git', ['grep', '-l', '-E', pattern, '--', '*.ts'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(matches.trim()).not.toBe('');
  });
});
