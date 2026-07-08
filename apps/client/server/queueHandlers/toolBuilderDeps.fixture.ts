/**
 * Real (NOT mocked) `ToolBuilderDeps` / `ToolBuilderCallbacks` for
 * `buildSharedTools`-level tests.
 *
 * The existing `buildSubagentLatticeToolPool` unit tests mock `buildSharedTools`
 * wholesale, so they never prove that real deps actually resolve `lattice_*`
 * tools out the other end (issue #214). This factory closes that gap cheaply:
 * `buildSharedTools` materialises EVERY b4m tool up front (schema + a `toolFn`
 * closure), but a tool's backing adapters - db repos, storage, llm - are only
 * touched INSIDE its `toolFn` at execution time, never at build time. So the
 * stubs here reject when called: a build-only test never runs a tool, and a
 * future test that DOES execute one fails loudly with a clear message instead of
 * silently reading `undefined`.
 *
 * Scope: the stubbed `db` covers the adapters the Lattice pool path resolves
 * (`apiKeys` / `adminSettings` / `latticeModels`). A test that enables a
 * different `enabledTools` set may need to stub additional adapters - the
 * fail-loud stubs make any such gap obvious at build time rather than silent.
 *
 * `deps`/`callbacks` overrides are shallow-merged so a caller can drop in a real
 * adapter (or a `vi.fn()`) for the one surface it exercises.
 */
import { Logger } from '@bike4mind/observability';
import type { ToolBuilderDeps, ToolBuilderCallbacks } from '@bike4mind/services';
import type { ICompletionBackend } from '@bike4mind/llm-adapters';
import type { IUserDocument } from '@bike4mind/common';

const rejectIfExecuted = (surface: string) => () => {
  throw new Error(
    `toolBuilderDeps.fixture: ${surface} was called - this fixture is build-only. ` +
      `Pass a real adapter via overrides to execute tools.`
  );
};

/**
 * A backend stand-in. `complete` rejects because build-time tool materialisation
 * never invokes the LLM.
 */
const fakeLlm = { complete: rejectIfExecuted('llm.complete') } as unknown as ICompletionBackend;

const fakeStorage = {
  upload: rejectIfExecuted('storage.upload'),
  getSignedUrl: rejectIfExecuted('storage.getSignedUrl'),
  getPublicUrl: rejectIfExecuted('storage.getPublicUrl'),
} as unknown as ToolBuilderDeps['storage'];

/** Minimal user document - build-time tool construction never reads its fields. */
const fakeUser = { _id: 'fixture-user', id: 'fixture-user' } as unknown as IUserDocument;

const fakeDb = {
  apiKeys: {
    findByUserIdAndType: rejectIfExecuted('db.apiKeys.findByUserIdAndType'),
    findByUserIdAndTypes: rejectIfExecuted('db.apiKeys.findByUserIdAndTypes'),
  },
  adminSettings: {
    findBySettingName: rejectIfExecuted('db.adminSettings.findBySettingName'),
    findBySettingNames: rejectIfExecuted('db.adminSettings.findBySettingNames'),
    findAll: rejectIfExecuted('db.adminSettings.findAll'),
  },
  // The Lattice adapter the tools persist through at execution time. Present so
  // the pool matches production wiring; rejects here because it is build-only.
  latticeModels: {
    create: rejectIfExecuted('db.latticeModels.create'),
    findById: rejectIfExecuted('db.latticeModels.findById'),
    update: rejectIfExecuted('db.latticeModels.update'),
  },
} as unknown as ToolBuilderDeps['db'];

export function makeToolBuilderDeps(overrides: Partial<ToolBuilderDeps> = {}): ToolBuilderDeps {
  return {
    userId: 'fixture-user',
    user: fakeUser,
    logger: new Logger(),
    db: fakeDb,
    storage: fakeStorage,
    imageGenerateStorage: fakeStorage,
    llm: fakeLlm,
    ...overrides,
  };
}

export function makeToolBuilderCallbacks(overrides: Partial<ToolBuilderCallbacks> = {}): ToolBuilderCallbacks {
  return {
    onStatusUpdate: async () => {},
    onToolStart: async () => {},
    onToolFinish: async () => {},
    ...overrides,
  };
}
