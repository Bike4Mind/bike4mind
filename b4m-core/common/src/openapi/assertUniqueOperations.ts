/** A registered operation's identity, for collision detection. */
export type OperationIdentity = { operationId: string; method: string; path: string };

/**
 * Throw if any `operationId` (an SDK method name) or `method + path` (a whole spec
 * operation) is declared twice - across BOTH contract-derived and hand-registered
 * operations. A duplicated operationId silently overwrites an SDK method name; a
 * duplicated route silently overwrites an entire operation in the generated spec.
 *
 * Runs at generate time (openapi/operations.ts), NOT at contract-array import time,
 * so a collision fails the spec build + tests rather than crashing every runtime
 * module that imports the `@bike4mind/common` barrel. Uses set membership (not an
 * `if (previous)` truthiness check) so an empty-string operationId can't slip a
 * duplicate past the guard.
 */
export function assertUniqueOperations(operations: readonly OperationIdentity[]): void {
  const seenOperationIds = new Set<string>();
  const seenRoutes = new Set<string>();

  for (const op of operations) {
    if (seenOperationIds.has(op.operationId)) {
      throw new Error(
        `Duplicate operationId "${op.operationId}": two OpenAPI operations share an SDK method name. ` +
          `operationIds must be unique across contracts (../api-contract) and hand-registered ops (openapi/operations.ts).`
      );
    }
    const route = `${op.method.toUpperCase()} ${op.path}`;
    if (seenRoutes.has(route)) {
      throw new Error(
        `Duplicate route "${route}": two OpenAPI operations would overwrite each other in the spec. ` +
          `Each method+path must be declared once across contracts and hand-registered ops.`
      );
    }
    seenOperationIds.add(op.operationId);
    seenRoutes.add(route);
  }
}
