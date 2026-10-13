import ts from 'typescript';

/**
 * Flags an entity document handed straight to `res.json()` / `res.send()` (RFC #483, Phase 2).
 *
 * Repositories return `toJSON()`/`toObject()` output typed `I<Entity>Document`, i.e. the full
 * persisted shape. Sending that as-is makes field exposure depend on someone remembering to
 * sanitize; `respond(res, schema, data)` (apps/client/server/utils/respond.ts) strips it to an
 * explicit allowlist instead. An entity is any interface that extends `IMongoDocument`
 * (b4m-core/common/src/types/entities/common.ts, pinned by the rule's test), a hydrated mongoose
 * document, or a `.lean()` result. Wrappers that keep the full field set (`Partial<>`) are looked
 * through; a projection (`Pick<>`, `Omit<>`, a Zod-inferred type) is an explicit shape.
 *
 * Checked: the body itself, array/tuple elements, union members, and object/array literal bodies
 * at any depth (`{ user }`, `{ data: { ...user } }`). Requires typed linting (projectService).
 */
export const ENTITY_BASE = 'IMongoDocument';
const SENDING_METHODS = new Set(['json', 'send']);
// Aliases whose result carries the same fields as their first type argument.
const FULL_SHAPE_WRAPPERS = new Set(['Partial', 'Required', 'Readonly', 'Require_id', 'Default__v']);
// mongoose's `.lean()` result type. Its argument is the schema-inferred raw shape, not the entity
// interface, so it is matched by name; mongoose types do not narrow it for `.select()`.
const LEAN_DOCUMENT_ALIAS = 'FlattenMaps';

function isMongooseDocumentClass(symbol) {
  return (
    symbol?.getName() === 'Document' &&
    (symbol.getDeclarations() ?? []).some(declaration =>
      /[\\/]mongoose[\\/]/.test(declaration.getSourceFile().fileName)
    )
  );
}

function extendsEntityBase(checker, type, seen) {
  if (seen.has(type)) return false;
  seen.add(type);
  if (type.isUnionOrIntersection()) return type.types.some(member => extendsEntityBase(checker, member, seen));
  const aliasName = type.aliasSymbol?.getName();
  if (aliasName === LEAN_DOCUMENT_ALIAS) return true;
  const [wrapped] = type.aliasTypeArguments ?? [];
  if (wrapped && FULL_SHAPE_WRAPPERS.has(aliasName)) return extendsEntityBase(checker, wrapped, seen);
  const symbol = type.getSymbol();
  if (symbol?.getName() === ENTITY_BASE || isMongooseDocumentClass(symbol)) return true;
  const isInterfaceOrClass =
    (type.flags & ts.TypeFlags.Object) !== 0 && (type.objectFlags & ts.ObjectFlags.ClassOrInterface) !== 0;
  if (!isInterfaceOrClass) return false;
  return (checker.getBaseTypes(type) ?? []).some(base => extendsEntityBase(checker, base, seen));
}

function isEntityPayload(checker, type) {
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    return checker.getTypeArguments(type).some(element => isEntityPayload(checker, element));
  }
  if (type.isUnion()) return type.types.some(member => isEntityPayload(checker, member));
  return extendsEntityBase(checker, type, new Set());
}

/** A response sends only if it is Express-like; any other object's `json()`/`send()` is ignored. */
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

    function reportEntitiesIn(node, method) {
      if (isEntity(node)) {
        context.report({ node, messageId: 'rawEntity', data: { method } });
        return;
      }
      const children =
        node.type === 'ObjectExpression'
          ? node.properties.map(property => (property.type === 'SpreadElement' ? property.argument : property.value))
          : node.type === 'ArrayExpression'
            ? node.elements.map(element => (element?.type === 'SpreadElement' ? element.argument : element))
            : [];
      for (const child of children) if (child) reportEntitiesIn(child, method);
    }

    return {
      'CallExpression[callee.type="MemberExpression"][callee.property.type="Identifier"]'(node) {
        const method = node.callee.property.name;
        const [body] = node.arguments;
        if (!SENDING_METHODS.has(method) || !body) return;
        if (!isResponseLike(services.getTypeAtLocation(node.callee.object))) return;
        reportEntitiesIn(body, method);
      },
    };
  },
};
