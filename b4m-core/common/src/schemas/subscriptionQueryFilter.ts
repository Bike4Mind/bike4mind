/**
 * Operator allow-list for the client-authored Mongo filter carried on a `subscribe_query` frame.
 *
 * The WS data-subscribe handler forwards that filter to `Model.find` and persists it on the
 * QuerySubscription the separate subscriber-fanout service replays, so an unconstrained
 * `$`-prefixed key lets any authenticated socket ask the database to run server-side JavaScript
 * (`$where`, `$expr` + `$function`) or an unbounded `$regex` - either of which pins a pooled
 * connection for as long as it runs.
 *
 * Live subscriptions only ever need equality, membership and range matching, so anything outside
 * this list is REFUSED rather than stripped: silently dropping an operator would quietly widen the
 * document set the caller ends up subscribed to.
 *
 * The scan is deliberately structural rather than a model of Mongo's grammar - it flags any
 * `$`-prefixed key anywhere in the tree that isn't allow-listed. It can therefore accept an
 * allow-listed operator in a position Mongo would treat as a literal sub-document field name, but
 * that is inert; what matters is that no disallowed operator can reach the driver.
 */

/** Combinators whose operands are themselves filters. */
export const SUBSCRIPTION_FILTER_LOGICAL_OPERATORS = ['$and', '$or', '$nor', '$not'] as const;

/** Value-level operators a subscription filter may use. */
export const SUBSCRIPTION_FILTER_VALUE_OPERATORS = [
  '$eq',
  '$ne',
  '$gt',
  '$gte',
  '$lt',
  '$lte',
  '$in',
  '$nin',
  '$exists',
  '$type',
  '$size',
  '$all',
  '$elemMatch',
] as const;

const ALLOWED_OPERATORS: ReadonlySet<string> = new Set<string>([
  ...SUBSCRIPTION_FILTER_LOGICAL_OPERATORS,
  ...SUBSCRIPTION_FILTER_VALUE_OPERATORS,
]);

/**
 * Bounds the recursion and the query planner's work. Well below MongoDB's own BSON nesting limit;
 * no in-repo subscription filter nests more than two levels.
 */
export const SUBSCRIPTION_FILTER_MAX_DEPTH = 12;

/**
 * Returns a dotted path for every part of `filter` a subscription may not send: a disallowed
 * `$`-prefixed key, a `RegExp` operand, or nesting past {@link SUBSCRIPTION_FILTER_MAX_DEPTH}.
 * An empty array means the filter is safe to forward to the database.
 */
export function findDisallowedSubscriptionFilterKeys(filter: unknown): string[] {
  const violations: string[] = [];

  const walk = (node: unknown, path: string, depth: number): void => {
    if (depth > SUBSCRIPTION_FILTER_MAX_DEPTH) {
      violations.push(`${path} (nested deeper than ${SUBSCRIPTION_FILTER_MAX_DEPTH})`);
      return;
    }
    if (node instanceof RegExp) {
      // Unreachable for a JSON frame, but a same-process TS caller can construct one, and a
      // catastrophically backtracking pattern is the same denial of service as `$regex`.
      violations.push(`${path} (regular expression)`);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((entry, i) => walk(entry, `${path}[${i}]`, depth + 1));
      return;
    }
    if (node === null || typeof node !== 'object') return;

    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const childPath = path ? `${path}.${key}` : key;
      if (key.startsWith('$') && !ALLOWED_OPERATORS.has(key)) {
        violations.push(childPath);
        continue;
      }
      walk(value, childPath, depth + 1);
    }
  };

  walk(filter, '', 0);
  return violations;
}
