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

// `where` targets whose schema declares no enum, so the value cannot be checked against it.
export const WHERE_WITHOUT_ENUM: readonly string[] = [
  // Written as a Mongoose model name (`User.modelName`) by ActivityRepository callers.
  'Activity.ownerType',
  // Plain strings; every writer passes CreditHolderType, whose user member is 'User'.
  'CreditTransaction.recipientType',
  'CreditTransaction.senderType',
  // No writer in the repo; typed string, mirrors CreditTransaction.ownerType (CreditHolderType).
  'FailedRefund.ownerType',
];

/** `exportScope` and `identifies` only mean something on a `retain` reference. */
export function hasMisplacedExportFields(reference: UserReference): boolean {
  return reference.action !== 'retain' && Boolean(reference.exportScope || reference.identifies);
}

/** Why a `where` value cannot match on this model, or undefined when the schema allows it. */
export function whereValueProblem(modelName: string, key: string, value: unknown): string | undefined {
  const schemaPath = mongoose.model(modelName).schema.path(key) as
    { enumValues?: unknown[]; isRequired?: boolean } | undefined;
  if (value === null) {
    // Matching an absent field is only meaningful on a declared path that may be absent.
    if (!schemaPath) return `${modelName}.${key} is not a schema path`;
    if (schemaPath.isRequired === true) return `${modelName}.${key} is required, so it is never absent`;
    return undefined;
  }
  const enumValues = schemaPath?.enumValues;
  if (!enumValues?.length) {
    return WHERE_WITHOUT_ENUM.includes(`${modelName}.${key}`)
      ? undefined
      : `${modelName}.${key} has no enum to check ${String(value)} against`;
  }
  return enumValues.includes(value) ? undefined : `${modelName}.${key} does not allow ${String(value)}`;
}

/** Without the unscoped anonymize, the person's id would survive on every row their organization owns. */
export function hasUnscopedAnonymizeFallback(holder: DataHolder, reference: UserReference): boolean {
  return referencesOf(holder).some(
    candidate =>
      candidate.path === reference.path && candidate.action === 'anonymize' && !candidate.scope && !candidate.where
  );
}

/** Why the registry entry disagrees with how Mongoose registered the model, or undefined when they agree. */
export function discriminatorMismatch(modelName: string, holder: DataHolder | undefined): string | undefined {
  const base = (mongoose.model(modelName) as { baseModelName?: string }).baseModelName;
  if (holder?.kind === 'discriminator') {
    return holder.base === base
      ? undefined
      : `is classified as a discriminator of "${holder.base}" but Mongoose has base "${base}"`;
  }
  return base === undefined ? undefined : `is a Mongoose discriminator of "${base}" and must be classified as one`;
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
  const mismatch = discriminatorMismatch(modelName, holder);
  if (mismatch) return fail(mismatch);

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

  const misplaced = references.filter(hasMisplacedExportFields).map(reference => reference.path);
  if (misplaced.length) fail(`exportScope or identifies set on non-retain references: ${misplaced.join(', ')}`);
  for (const reference of references) {
    for (const [key, value] of Object.entries(reference.where ?? {})) {
      const problem = whereValueProblem(modelName, key, value);
      if (problem) fail(`where value rejected: ${problem}`);
    }
    if (reference.scope === 'personal' && !hasUnscopedAnonymizeFallback(holder, reference)) {
      fail(`personal-scoped reference "${reference.path}" has no unscoped anonymize for organization rows`);
    }
  }
}
