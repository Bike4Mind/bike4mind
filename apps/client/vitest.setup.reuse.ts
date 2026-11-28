import { createRequire } from 'node:module';
import { afterAll, afterEach, expect, vi } from 'vitest';

type ModuleNode = { promise?: unknown; exports?: unknown; evaluated: boolean; importers: Set<string> };
type Internals = {
  __vitest_worker__?: { evaluatedModules: { idToModuleMap: Map<string, ModuleNode> } };
  __vitest_mocker__?: { reset(): void };
};
// Runs first in every test file when workers are reused (`isolate: false`, see vitest.config.mts).
// vitest only clears its mock registry and module cache between files when it isolates them, so
// this does it by hand, through the same worker internals vitest's own reset uses. If a vitest
// upgrade renames them the optional chains go quiet and mocks start leaking between files:
// CLIENT_TEST_ISOLATE=1 is the comparison run.
type StyleCache = { sheet: { flush(): void }; inserted: object; registered: object };
const internals = globalThis as unknown as Internals;
internals.__vitest_mocker__?.reset();
vi.resetModules();
internals.__vitest_worker__?.evaluatedModules.idToModuleMap.forEach((node, id) => {
  if (!id.startsWith('mock:')) return;
  node.promise = undefined;
  node.exports = undefined;
  node.evaluated = false;
  node.importers.clear();
});

const SNAPSHOT = Symbol.for('b4m.test.globalSnapshot');
type Snapshot = {
  values: Map<PropertyKey, { value: unknown; descriptor: PropertyDescriptor }>;
  // Objects tests redefine properties on (visibilityState, clipboard, ...), with what they owned.
  owned: [object, Map<PropertyKey, PropertyDescriptor>][];
  envObject: NodeJS.ProcessEnv;
  env: Record<string, string | undefined>;
};
const holder = globalThis as unknown as Record<PropertyKey, unknown>;
const descriptorsOf = (target: object) =>
  new Map(Reflect.ownKeys(target).map(key => [key, Object.getOwnPropertyDescriptor(target, key)!]));

// One snapshot per environment instance: a worker that moves between the node and jsdom projects
// gets a new set of globals each time, and values captured under the last one are dead objects.
const environment: object = typeof document === 'undefined' ? globalThis : document;
const snapshots = (holder[SNAPSHOT] ??= new WeakMap<object, Snapshot>()) as WeakMap<object, Snapshot>;
if (!snapshots.has(environment)) {
  snapshots.set(environment, {
    values: new Map(
      Reflect.ownKeys(globalThis)
        .filter(key => key !== SNAPSHOT)
        .map(key => [key, { value: holder[key], descriptor: Object.getOwnPropertyDescriptor(globalThis, key)! }])
    ),
    owned: (typeof document === 'undefined' ? [] : [navigator, document]).map(target => [
      target,
      descriptorsOf(target),
    ]),
    envObject: process.env,
    env: { ...process.env },
  });
}
const snapshot = snapshots.get(environment)!;

function restoreGlobals() {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  // A suite that swaps in a copy (`process.env = { ...saved }`) leaves a plain object behind, and
  // node only acts on writes to the real one: TZ, for a start.
  if (process.env !== snapshot.envObject) process.env = snapshot.envObject;
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot.env)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot.env)) {
    if (process.env[key] !== value) process.env[key] = value;
  }
  for (const [key, { value, descriptor }] of snapshot.values) {
    // Two ways a test swaps a global: redefining the property (window.location), which only the
    // original descriptor undoes, and assigning it (fetch), which only the original value does.
    const current = Object.getOwnPropertyDescriptor(globalThis, key);
    if (current?.configurable && (current.get !== descriptor.get || current.set !== descriptor.set)) {
      Object.defineProperty(globalThis, key, descriptor);
    }
    if (holder[key] === value) continue;
    try {
      holder[key] = value;
    } catch {
      // read-only global: nothing a test could have replaced
    }
  }
  for (const [target, descriptors] of snapshot.owned) {
    for (const key of Reflect.ownKeys(target)) {
      if (!descriptors.has(key)) Reflect.deleteProperty(target, key);
    }
    for (const [key, descriptor] of descriptors) {
      if (descriptor.configurable) Object.defineProperty(target, key, descriptor);
    }
  }
}

restoreGlobals();

let resetDocument: (() => void) | undefined;
if (typeof window !== 'undefined') {
  const { cleanup, renderHook } = await import('@testing-library/react');
  // Registered here because vitest.setup.ts gets them from a side-effect import that node runs once
  // per worker, while each file gets a new `expect`. The cast drops the module's `default` export.
  const matchers = await import('@testing-library/jest-dom/matchers');
  expect.extend(matchers as unknown as Parameters<typeof expect.extend>[0]);

  // jest-dom's css.escape polyfill writes CSS.escape once, when node first loads it. That write
  // goes with the window of the file that triggered it, so later windows need it handed back.
  const CSS_POLYFILL = Symbol.for('b4m.test.cssPolyfill');
  if (holder.CSS) holder[CSS_POLYFILL] = holder.CSS;
  else if (holder[CSS_POLYFILL]) holder.CSS = holder[CSS_POLYFILL];

  // A listener app code puts on window or document outlives the file that added it: a drag left
  // mid-flight, a module that subscribes on import. Library listeners are left alone, since
  // user-event and react-dom wire each document once and never again.
  const LISTENERS = Symbol.for('b4m.test.leakedListeners');
  const TRACKING = Symbol.for('b4m.test.tracksListeners');
  type Registration = [EventTarget, string, EventListenerOrEventListenerObject | null, unknown];
  type Tracked = EventTarget['addEventListener'] & { [TRACKING]?: true };
  const scope = document as unknown as Record<PropertyKey, unknown>;
  const registrations = (scope[LISTENERS] ??= []) as Registration[];
  // Checked per file, not once: `window` is the global object here, so the global restore above
  // puts its original addEventListener back.
  for (const target of [window, document] as EventTarget[]) {
    if ((target.addEventListener as Tracked)[TRACKING]) continue;
    const add = target.addEventListener.bind(target);
    const tracked: Tracked = (type: string, listener: EventListenerOrEventListenerObject | null, options?: unknown) => {
      const caller = new Error().stack?.split('\n')[2] ?? '';
      if (!caller.includes('/node_modules/')) registrations.push([target, type, listener, options]);
      add(type, listener, options as AddEventListenerOptions);
    };
    tracked[TRACKING] = true;
    target.addEventListener = tracked;
  }

  // Joy's style engine, loaded the way Joy loads it so this is the instance holding its rule cache.
  // It is not a dependency of this package, hence the walk down Joy's own dependency chain.
  const resolveFrom = (from: string, specifier: string) => createRequire(from).resolve(specifier);
  const styledEngine = resolveFrom(
    resolveFrom(resolveFrom(import.meta.url, '@mui/joy'), '@mui/system'),
    '@mui/styled-engine'
  );
  const { __unsafe_useEmotionCache: useStyleCache } = createRequire(styledEngine)('@emotion/react') as {
    __unsafe_useEmotionCache: () => StyleCache;
  };
  const cacheProbe = renderHook(() => useStyleCache());
  const styleCache = cacheProbe.result.current;
  cacheProbe.unmount();

  resetDocument = () => {
    for (const [target, type, listener, options] of registrations.splice(0)) {
      target.removeEventListener(type, listener, options as EventListenerOptions);
    }
    // Left alone, the document collects every rule any earlier file rendered, and jsdom walks
    // all of them on each style read. Emptied through the cache: it also tracks what it inserted.
    styleCache.sheet.flush();
    styleCache.inserted = {};
    styleCache.registered = {};
    localStorage.clear();
    sessionStorage.clear();
    for (const cookie of document.cookie.split(';')) {
      const name = cookie.split('=')[0].trim();
      if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
    }
    // Joy shows a focus ring only after keyboard input, tracked in a module node loads once: a
    // click in one file would otherwise hide the ring in every file after it.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
    window.history.replaceState(null, '', '/');
    document.title = '';
    // cleanup() only unmounts what Testing Library rendered: a node a test appended by hand stays.
    document.body.replaceChildren();
    for (const element of [document.documentElement, document.body]) {
      for (const attribute of [...element.attributes]) element.removeAttribute(attribute.name);
    }
  };
  resetDocument();
  afterEach(() => {
    cleanup();
  });
}

// Recharts keeps measured text sizes in a module-level cache that outlives the file (node holds the
// module), so a file that stubs getBoundingClientRect would make later charts wrap their labels. Not
// exported from the package entry; required so it is the same CJS copy the charts load.
const { clearStringCache } = createRequire(import.meta.url)('recharts/lib/util/DOMUtils') as {
  clearStringCache(): void;
};

// One hook, in this order: clearing cookies goes through URL, which a test may have stubbed.
afterAll(() => {
  restoreGlobals();
  resetDocument?.();
  clearStringCache();
});
