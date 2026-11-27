/**
 * A structural patch from one OpenAPI document to another. The deployment spec is the core spec plus
 * add-on operations and schemas, so shipping it as a patch over the committed core spec keeps one copy
 * of the shared document (~1.7 MB bundled) in the server bundle instead of two. Pure and dependency-free: the
 * generator (diff) runs at build time and the route (apply) at module load.
 */

export type OpenApiPatchNode = {
  /** Every key of the patched object, in output order. A key absent here is removed. */
  order: string[];
  /** Keys that are new or replaced wholesale. */
  set?: Record<string, unknown>;
  /** Keys whose value is an object patched in place. */
  nested?: Record<string, OpenApiPatchNode>;
};

// doc -> paths/components -> schemas: path items and schema objects are replaced wholesale.
const MAX_NESTED_DEPTH = 2;

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Own-key checks and defineProperty keep keys like "toString" or "__proto__" from resolving through the
// prototype chain or rewriting the prototype.
function assign(target: PlainObject, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

export function diffOpenApiDocument(base: PlainObject, next: PlainObject, depth = 0): OpenApiPatchNode {
  const patch: OpenApiPatchNode = { order: Object.keys(next) };
  for (const key of patch.order) {
    const nextValue = next[key];
    if (!Object.hasOwn(base, key)) {
      assign((patch.set ??= {}), key, nextValue);
      continue;
    }
    const baseValue = base[key];
    if (JSON.stringify(baseValue) === JSON.stringify(nextValue)) continue;
    if (depth < MAX_NESTED_DEPTH && isPlainObject(baseValue) && isPlainObject(nextValue)) {
      assign((patch.nested ??= {}), key, diffOpenApiDocument(baseValue, nextValue, depth + 1));
      continue;
    }
    assign((patch.set ??= {}), key, nextValue);
  }
  return patch;
}

export function applyOpenApiPatch(base: PlainObject, patch: OpenApiPatchNode): PlainObject {
  const result: PlainObject = {};
  for (const key of patch.order) {
    if (patch.set && Object.hasOwn(patch.set, key)) {
      assign(result, key, patch.set[key]);
      continue;
    }
    if (!Object.hasOwn(base, key)) throw new Error(`OpenAPI patch expects "${key}" in the base document`);
    const nested = patch.nested && Object.hasOwn(patch.nested, key) ? patch.nested[key] : undefined;
    const baseValue = base[key];
    if (nested) {
      if (!isPlainObject(baseValue)) throw new Error(`OpenAPI patch expects "${key}" to be an object`);
      assign(result, key, applyOpenApiPatch(baseValue, nested));
      continue;
    }
    assign(result, key, baseValue);
  }
  return result;
}
