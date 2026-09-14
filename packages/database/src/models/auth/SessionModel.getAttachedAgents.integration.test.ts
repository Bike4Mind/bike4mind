import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { Session, sessionRepository } from './SessionModel';

/**
 * `agentIds` is declared `[{ type: String }]` but names ObjectId-keyed rows, and every caller
 * resolves the returned ids one at a time via `agentRepository.findById`. One legacy entry made
 * that throw a CastError, which /api/sessions/:id/agents surfaced as a 404 for the whole list.
 * Real server, because the behaviour under test is Mongo's casting.
 */

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

const LIVE_AGENT_ID = '67dbe18a7f9cf1fa5d968600';
const JUNK_AGENT_ID = 'agent-uuid-not-an-objectid';

const createSession = async (agentIds: string[]) => {
  const s = await Session.create({
    name: 'probe',
    userId: 'owner-1',
    lastUpdated: new Date(),
    firstCreated: new Date(),
    agentIds,
  });
  return String(s._id);
};

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

describe('getAttachedAgents', () => {
  it('returns the ids that can address a row', async () => {
    const id = await createSession([LIVE_AGENT_ID]);
    expect(await sessionRepository.getAttachedAgents(id)).toEqual([LIVE_AGENT_ID]);
  });

  it('keeps the usable id when the list also holds one that cannot address a row', async () => {
    const id = await createSession([JUNK_AGENT_ID, LIVE_AGENT_ID]);
    expect(await sessionRepository.getAttachedAgents(id)).toEqual([LIVE_AGENT_ID]);
  });

  it('returns an empty list rather than a value that makes findById throw', async () => {
    const id = await createSession([JUNK_AGENT_ID]);
    const ids = await sessionRepository.getAttachedAgents(id);

    expect(ids).toEqual([]);
    // The point of the guard: what comes back is safe to feed straight to a by-id lookup.
    await expect(Promise.all(ids.map(agentId => Session.findById(agentId)))).resolves.toEqual([]);
  });
});
