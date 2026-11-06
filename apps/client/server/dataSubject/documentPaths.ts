/**
 * Dotted-path helpers over lean Mongo documents, with Mongo's array semantics: a path segment that
 * lands on an array applies to every element (`users.userId` reads the `userId` of each member).
 */

type PlainObject = Record<string, unknown>;

const isPlainObject = (value: unknown): value is PlainObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Every leaf value at `path`, flattened through arrays. Empty when the path is absent. */
export function valuesAt(document: unknown, path: string): unknown[] {
  return collect(document, path.split('.'));
}

function collect(value: unknown, segments: readonly string[]): unknown[] {
  if (Array.isArray(value)) return value.flatMap(element => collect(element, segments));
  if (segments.length === 0) return [value];
  if (!isPlainObject(value)) return [];
  const [head, ...rest] = segments;
  return Object.hasOwn(value, head) ? collect(value[head], rest) : [];
}

/** Removes `path` from the document in place, through every array element on the way. */
export function omitPath(document: unknown, path: string): void {
  remove(document, path.split('.'));
}

function remove(value: unknown, segments: readonly string[]): void {
  if (Array.isArray(value)) {
    for (const element of value) remove(element, segments);
    return;
  }
  if (!isPlainObject(value) || segments.length === 0) return;
  const [head, ...rest] = segments;
  if (rest.length === 0) {
    delete value[head];
    return;
  }
  remove(value[head], rest);
}

export type ArrayMatch = { arrayPath: string; elements: unknown[] };

/**
 * For a `pullFromArray` path, the array it addresses and only the elements whose value (the
 * element itself for `recipientUserIds`, its key for `users.userId`) satisfies `matches`. Null when
 * the path never reaches an array, which a classified `pullFromArray` path always does.
 */
export function matchingArrayElements(
  document: unknown,
  path: string,
  matches: (value: unknown) => boolean
): ArrayMatch | null {
  const segments = path.split('.');
  let current: unknown = document;
  for (let index = 0; index < segments.length; index++) {
    if (!isPlainObject(current)) return null;
    current = current[segments[index]];
    if (!Array.isArray(current)) continue;
    const elementPath = segments.slice(index + 1);
    const elements = current.filter(element =>
      elementPath.length === 0 ? matches(element) : collect(element, elementPath).some(matches)
    );
    return { arrayPath: segments.slice(0, index + 1).join('.'), elements };
  }
  return null;
}

/** Writes `value` at `path`, creating plain objects along the way. */
export function setPath(target: PlainObject, path: string, value: unknown): void {
  const segments = path.split('.');
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (!isPlainObject(next)) current[segment] = {};
    current = current[segment] as PlainObject;
  }
  current[segments[segments.length - 1]] = value;
}
