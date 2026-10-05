import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { agentExecutionRepository } from '@bike4mind/database';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { resolveInvocationEnabledTools, type ResolvedOrchestrationProfile } from './agentExecutor.orchestrationProfile';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const SAVE = 'save_content_to_data_lake';
const CREATE = 'create_data_lake';

// Agent whose own denylist replaced the org default, belt from admin defaults (the QA agent).
const profile: ResolvedOrchestrationProfile = {
  id: 'agent-1',
  name: 'Lake agent',
  allowedTools: ['web_search', 'edit_file'],
  deniedTools: ['edit_file'],
  maxIterations: { quick: 3, medium: 10, very_thorough: 20 },
  defaultThoroughness: 'medium',
  isSynthetic: false,
  allowedToolsFromDefaults: true,
};

let server: MongoMemoryServer;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

/** First invocation as processExecution runs it: resolve, then persist onto the real record. */
async function startRun(payloadEnabledTools: string[]) {
  const exec = await agentExecutionRepository.create({
    userId: new mongoose.Types.ObjectId().toString(),
    sessionId: new mongoose.Types.ObjectId().toString(),
    questId: new mongoose.Types.ObjectId().toString(),
    query: 'Create a data lake and save this into it',
    model: 'test-model',
    status: 'pending',
    approvedTools: [],
    deniedTools: [],
    iterationBilling: [],
    totalCreditsUsed: 0,
    lambdaInvocationCount: 1,
    childExecutionIds: [],
  });
  const first = resolveInvocationEnabledTools({
    isNewExecution: true,
    persistedEnabledTools: undefined,
    persistedProfileDeniedTools: undefined,
    payloadEnabledTools,
    payloadIsAmbient: true,
    profile,
    hasApprover: true,
  });
  await agentExecutionRepository.persistProfileDeniedTools(exec.id, profile.deniedTools);
  await agentExecutionRepository.persistResolvedEnabledTools(exec.id, first);
  return { id: exec.id, first };
}

/** A post-approval continuation: no start payload, and no profile outside the optimizer surface. */
async function continueRun(id: string) {
  const loaded = await agentExecutionRepository.findById(id);
  return resolveInvocationEnabledTools({
    isNewExecution: false,
    persistedEnabledTools: loaded?.resolvedEnabledTools,
    persistedProfileDeniedTools: loaded?.profileDeniedTools,
    payloadEnabledTools: undefined,
    payloadIsAmbient: undefined,
    profile: undefined,
    hasApprover: true,
  });
}

describe('continuation toolbelt', () => {
  it('keeps the ambient smart tool and its paired create tool after a permission approval', async () => {
    const { id, first } = await startRun([SAVE]);
    expect(first).toEqual(expect.arrayContaining([SAVE, CREATE, 'web_search']));

    const resumed = await continueRun(id);
    expect(resumed).toEqual(first);
    expect(resumed).toContain(CREATE);
  });

  it('keeps a profile-denied tool stripped on the continuation', async () => {
    const { id, first } = await startRun([SAVE, 'edit_file']);
    expect(first).not.toContain('edit_file');
    expect(await continueRun(id)).not.toContain('edit_file');

    // Even a persisted belt that somehow carries the denied name is filtered again.
    await agentExecutionRepository.persistResolvedEnabledTools(id, [...first, 'edit_file']);
    expect(await continueRun(id)).not.toContain('edit_file');
  });

  it('keeps the legacy recompute for a record with no persisted toolbelt', async () => {
    const exec = await agentExecutionRepository.create({
      userId: new mongoose.Types.ObjectId().toString(),
      sessionId: new mongoose.Types.ObjectId().toString(),
      questId: new mongoose.Types.ObjectId().toString(),
      query: 'legacy',
      model: 'test-model',
      status: 'awaiting_permission',
      approvedTools: [],
      deniedTools: [],
      iterationBilling: [],
      totalCreditsUsed: 0,
      lambdaInvocationCount: 1,
      childExecutionIds: [],
    });
    const loaded = await agentExecutionRepository.findById(exec.id);
    expect(loaded?.resolvedEnabledTools).toBeUndefined();
    expect(await continueRun(exec.id)).toEqual([]);
  });
});

describe('agentExecutor continuation toolbelt wiring', () => {
  const source = readFileSync(join(__dirname, 'agentExecutor.ts'), 'utf8');

  it('replays the persisted belt and persists it on the first invocation', () => {
    expect(source).toMatch(
      /resolveInvocationEnabledTools\(\{[^}]*persistedEnabledTools: execution\.resolvedEnabledTools,[^}]*persistedProfileDeniedTools: execution\.profileDeniedTools,/
    );
    expect(source).toMatch(
      /if \(isNewExecution\) \{\s*await agentExecutionRepository\.persistResolvedEnabledTools\(executionId, profileEnabledTools\);/
    );
  });

  it('falls back to the persisted profile denials in the session policy pass', () => {
    expect(source).toMatch(
      /profileDeniedTools: orchestrationProfile\?\.deniedTools \?\? execution\.profileDeniedTools,/
    );
  });
});
