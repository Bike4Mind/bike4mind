import ts from 'typescript';

/**
 * Flags an entity document handed straight to `res.json()` / `res.send()` (RFC #483, Phase 2).
 *
 * Repositories return `toJSON()`/`toObject()` output typed `I<Entity>Document`, i.e. the full
 * persisted shape. Sending that as-is makes field exposure depend on someone remembering to
 * sanitize; `respond(res, schema, data)` (apps/client/server/utils/respond.ts) strips it to an
 * explicit allowlist instead. An entity is any interface that extends `IMongoDocument`
 * (b4m-core/common/src/types/entities/common.ts) - keep ENTITY_BASE in sync with that name.
 *
 * Checked: the body itself, array elements, union members, and one level of an object literal
 * body (`{ user }`, `{ ...user }`). A mapped/projected type (`Pick<>`, `Omit<>`, a Zod-inferred
 * type) is an explicit shape and is not flagged. Requires typed linting (projectService).
 */
const ENTITY_BASE = 'IMongoDocument';
const SENDING_METHODS = new Set(['json', 'send']);

function extendsEntityBase(checker, type, seen) {
  if (seen.has(type)) return false;
  seen.add(type);
  if (type.isUnionOrIntersection()) return type.types.some(member => extendsEntityBase(checker, member, seen));
  if (type.getSymbol()?.getName() === ENTITY_BASE) return true;
  const isInterfaceOrClass =
    (type.flags & ts.TypeFlags.Object) !== 0 && (type.objectFlags & ts.ObjectFlags.ClassOrInterface) !== 0;
  if (!isInterfaceOrClass) return false;
  return (checker.getBaseTypes(type) ?? []).some(base => extendsEntityBase(checker, base, seen));
}

function isEntityPayload(checker, type) {
  if (checker.isArrayType(type)) {
    return checker.getTypeArguments(type).some(element => isEntityPayload(checker, element));
  }
  if (type.isUnion()) return type.types.some(member => isEntityPayload(checker, member));
  return extendsEntityBase(checker, type, new Set());
}

/** Only an Express-style response sends; `fetch`'s `Response.json()` and friends take no body. */
function isResponseLike(type) {
  return Boolean(type.getProperty('status') && type.getProperty('json'));
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow sending a raw entity document from an API route' },
    messages: {
      rawEntity:
        'Raw entity document sent via res.{{method}}(): its full persisted shape reaches the client. ' +
        'Send it through respond(res, schema, data) from @server/utils/respond so the response is an explicit allowlist.',
    },
    schema: [],
  },
  create(context) {
    const services = context.sourceCode.parserServices;
    if (!services?.program) {
      throw new Error('b4m/no-raw-entity-response requires typed linting (parserOptions.projectService).');
    }
    const checker = services.program.getTypeChecker();
    const isEntity = node => isEntityPayload(checker, services.getTypeAtLocation(node));

    return {
      'CallExpression[callee.type="MemberExpression"][callee.property.type="Identifier"]'(node) {
        const method = node.callee.property.name;
        const [body] = node.arguments;
        if (!SENDING_METHODS.has(method) || !body) return;
        if (!isResponseLike(services.getTypeAtLocation(node.callee.object))) return;

        if (isEntity(body)) {
          context.report({ node: body, messageId: 'rawEntity', data: { method } });
          return;
        }
        if (body.type !== 'ObjectExpression') return;
        for (const property of body.properties) {
          const value = property.type === 'SpreadElement' ? property.argument : property.value;
          if (isEntity(value)) context.report({ node: property, messageId: 'rawEntity', data: { method } });
        }
      },
    };
  },
};
