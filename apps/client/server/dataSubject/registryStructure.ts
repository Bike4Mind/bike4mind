import { mongoose } from '@bike4mind/database';
import { uniqueIndexPaths } from './placeholder';
import { schemaDeclaresPath } from './schemaPaths';
import type { DataHolder, DataHolderRegistry, UserReference } from './types';

export function alsoRedactOf(reference: UserReference): readonly string[] {
  return reference.action === 'anonymize' || reference.action === 'retain' ? (reference.alsoRedact ?? []) : [];
}

export function referencePaths(reference: UserReference): string[] {
  const scopePaths = reference.scope === 'personal' ? ['organizationId'] : [];
  return [
    reference.path,
    ...Object.keys(reference.where ?? {}),
    ...scopePaths,
    ...alsoRedactOf(reference),
    ...(reference.identifies ?? []),
  ];
}

export function referencesOf(holder: DataHolder): readonly UserReference[] {
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

export function declaredPathsOf(holder: DataHolder): string[] {
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

/** A pullFromArray path is an array, or a key inside one. */
export function isArrayOrArrayKey(schema: mongoose.Schema, path: string): boolean {
  const isArray = (candidate: string) => /Array/.test(schema.path(candidate)?.instance ?? '');
  const parentPath = path.includes('.') ? path.slice(0, path.lastIndexOf('.')) : '';
  return isArray(path) || (parentPath !== '' && isArray(parentPath));
}

/** Returns the parent chain from `modelName` up to its first non-viaParent entry, or throws on a cycle. */
export function walkParentChain(modelName: string, registry: DataHolderRegistry): string[] {
  const seen = [modelName];
  let current: DataHolder | undefined = registry[modelName];
  while (current?.kind === 'viaParent') {
    if (seen.includes(current.parent)) {
      throw new Error(`Data holder "${modelName}": parent cycle through ${[...seen, current.parent].join(' -> ')}`);
    }
    seen.push(current.parent);
    current = registry[current.parent];
  }
  return seen;
}

/** Throws a message naming the model and the rule an entry breaks. */
export function assertEntryStructure(modelName: string, registry: DataHolderRegistry): void {
  const fail = (rule: string): never => {
    throw new Error(`Data holder "${modelName}": ${rule}`);
  };
  const holder = registry[modelName];
  if (!holder) return fail('is not in the registry');
  if (!mongoose.modelNames().includes(modelName)) {
    return fail('is not a registered Mongoose model; the module that classifies it must also import its model');
  }
  const { schema } = mongoose.model(modelName);

  if (holder.kind === 'viaParent') {
    const chain = walkParentChain(modelName, registry);
    const end = registry[chain[chain.length - 1]];
    if (!end) return fail(`parent "${chain[chain.length - 1]}" is not in the registry`);
    if (end.kind !== 'holder') {
      return fail(`parent chain ${chain.join(' -> ')} does not end at a holder (ends at kind "${end.kind}")`);
    }
    const parentKey = holder.parentKey ?? '_id';
    if (!mongoose.modelNames().includes(holder.parent))
      return fail(`parent "${holder.parent}" is not a registered model`);
    if (!schemaDeclaresPath(mongoose.model(holder.parent).schema, parentKey)) {
      return fail(`parentKey "${parentKey}" is not declared by the schema of "${holder.parent}"`);
    }
  }

  const undeclared = declaredPathsOf(holder).filter(path => !schemaDeclaresPath(schema, path));
  if (undeclared.length) return fail(`paths not declared by the schema: ${undeclared.join(', ')}`);

  const references = referencesOf(holder);
  for (const reference of references) {
    if (reference.action === 'pullFromArray' && !isArrayOrArrayKey(schema, reference.path)) {
      fail(`pullFromArray path "${reference.path}" is not an array or a key inside one`);
    }
  }
  const unique = uniqueIndexPaths(schema);
  const collisions = references.flatMap(reference => alsoRedactOf(reference).filter(path => unique.has(path)));
  if (collisions.length) fail(`alsoRedact paths carry a unique index: ${collisions.join(', ')}`);
}
