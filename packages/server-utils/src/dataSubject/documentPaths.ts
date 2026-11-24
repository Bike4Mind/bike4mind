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

/** `origins[i]` is the stored array element `elements[i]` came from (itself unless cut down). */
export type ArrayMatch = { arrayPath: string; elements: unknown[]; origins: unknown[] };

/**
 * For a path that reaches an array, the first array it addresses and only the elements whose value
 * (the element itself for `recipientUserIds`, its key for `users.userId`) satisfies `matches`. When
 * the path crosses a nested array (`examples.verdicts.reviewerId`), each outer element is cut down to
 * the matching inner elements alone, since the rest of it belongs to whoever the outer element is
 * about. Null when the path never reaches an array.
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
    const elementPath = segments.slice(index + 1).join('.');
    const elements: unknown[] = [];
    const origins: unknown[] = [];
    for (const element of current) {
      for (const part of matchingPart(element, elementPath, matches)) {
        elements.push(part);
        origins.push(element);
      }
    }
    return { arrayPath: segments.slice(0, index + 1).join('.'), elements, origins };
  }
  return null;
}

/** The part of one array element `elementPath` matches: the element, its nested match, or nothing. */
function matchingPart(element: unknown, elementPath: string, matches: (value: unknown) => boolean): unknown[] {
  if (elementPath === '') return matches(element) ? [element] : [];
  const nested = matchingArrayElements(element, elementPath, matches);
  if (!nested) return collect(element, elementPath.split('.')).some(matches) ? [element] : [];
  if (nested.elements.length === 0) return [];
  const part: PlainObject = {};
  setPath(part, nested.arrayPath, nested.elements);
  return [part];
}

/**
 * A copy of `value` whose arrays and plain objects are new, so it can be edited in place without
 * touching the source; other values (ObjectId, Date) are shared, as they are never edited.
 */
export function cloneContainers<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneContainers) as T;
  if (!isPlainObject(value)) return value;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneContainers(entry)])) as T;
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
