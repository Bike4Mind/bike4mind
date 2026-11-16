// Core's tutorial drafts: the profile's capture wiring and store.
// Server-only, like the registry (see registry.clientImports.test.ts).
import { WORKSPACE_SURFACES } from '@bike4mind/common';
import { questRepository, sessionRepository } from '@bike4mind/database';
import { coreModels } from './core';
import { CORE_DRAFT_PROFILE, coreDraftCore, coreDraftKnownSelectors } from './coreDraftProfile';
import { scrubPlainTranscript, type CaptureDeps, type CaptureHooks } from './drafts/capture';
import { draftStore } from './drafts/store';
import { anchorChoicesOf } from './routes/overridesRoute';
import { validateSheet } from './validate';

export { CORE_DRAFT_PROFILE, CORE_DRAFT_SELECTORS, coreDraftCore } from './coreDraftProfile';

const captureDeps: CaptureDeps = {
  loadOwnedSession: async (sessionId, userId) =>
    (await sessionRepository.findByIdAndUserId(sessionId, userId)) as never,
  quests: async sessionId => (await questRepository.findAllBySessionId(sessionId)) as never,
};

const captureHooks: CaptureHooks<{ turn: number }> = {
  acceptsSurface: surface => !surface,
  foreignToolPrefixes: WORKSPACE_SURFACES.flatMap(s => (s.toolNamePrefix ? [s.toolNamePrefix] : [])),
  scrub: scrubPlainTranscript,
};

export const coreDraftStore = draftStore({
  models: coreModels,
  core: coreDraftCore,
  profile: CORE_DRAFT_PROFILE,
  capture: { deps: captureDeps, hooks: captureHooks },
  choices: { ...anchorChoicesOf(coreDraftKnownSelectors), canvasTabs: [] },
  validateSheet,
});
