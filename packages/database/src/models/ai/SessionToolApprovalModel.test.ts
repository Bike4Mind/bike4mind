import { describe, it, expect, beforeEach } from 'vitest';
import SessionToolApprovalModel, { sessionToolApprovalRepository as repo } from './SessionToolApprovalModel';
import { setupMongoTest } from '../../__test__/utils';

const USER = 'user-1';
const SESSION = 'session-1';

describe('SessionToolApprovalRepository', () => {
  setupMongoTest();
  beforeEach(async () => {
    await SessionToolApprovalModel.ensureIndexes();
  });

  it('returns null before the user has remembered anything', async () => {
    expect(await repo.findByUserAndSession(USER, SESSION)).toBeNull();
  });

  it('upserts on the first remembered decision and accumulates on later ones', async () => {
    await repo.rememberDecision(USER, SESSION, 'send_slack_message', 'approved');
    await repo.rememberDecision(USER, SESSION, 'image_generation', 'approved');

    const remembered = await repo.findByUserAndSession(USER, SESSION);
    expect(remembered?.approvedTools.sort()).toEqual(['image_generation', 'send_slack_message']);
    expect(remembered?.deniedTools).toEqual([]);
  });

  it('does not duplicate a tool approved twice', async () => {
    await repo.rememberDecision(USER, SESSION, 'send_slack_message', 'approved');
    await repo.rememberDecision(USER, SESSION, 'send_slack_message', 'approved');

    expect((await repo.findByUserAndSession(USER, SESSION))?.approvedTools).toEqual(['send_slack_message']);
  });

  it('lets a later decision supersede an earlier one instead of leaving the tool on both lists', async () => {
    // `deniedTools` wins at the gate, so a tool left on both lists would silently stay blocked
    // after the user changed their mind.
    await repo.rememberDecision(USER, SESSION, 'image_generation', 'denied');
    await repo.rememberDecision(USER, SESSION, 'image_generation', 'approved');

    const remembered = await repo.findByUserAndSession(USER, SESSION);
    expect(remembered?.approvedTools).toEqual(['image_generation']);
    expect(remembered?.deniedTools).toEqual([]);

    await repo.rememberDecision(USER, SESSION, 'image_generation', 'denied');
    const flipped = await repo.findByUserAndSession(USER, SESSION);
    expect(flipped?.approvedTools).toEqual([]);
    expect(flipped?.deniedTools).toEqual(['image_generation']);
  });

  it('scopes decisions to one user, so a shared notebook does not leak approvals', async () => {
    await repo.rememberDecision(USER, SESSION, 'send_slack_message', 'approved');

    expect(await repo.findByUserAndSession('user-2', SESSION)).toBeNull();
  });

  it('scopes decisions to one session', async () => {
    await repo.rememberDecision(USER, SESSION, 'send_slack_message', 'approved');

    expect(await repo.findByUserAndSession(USER, 'session-2')).toBeNull();
  });

  it('forgetTool revokes one decision and leaves the rest', async () => {
    await repo.rememberDecision(USER, SESSION, 'send_slack_message', 'approved');
    await repo.rememberDecision(USER, SESSION, 'image_generation', 'denied');

    const remaining = await repo.forgetTool(USER, SESSION, 'send_slack_message');
    expect(remaining?.approvedTools).toEqual([]);
    expect(remaining?.deniedTools).toEqual(['image_generation']);
  });

  it('forgetAll clears the row entirely', async () => {
    await repo.rememberDecision(USER, SESSION, 'send_slack_message', 'approved');
    await repo.forgetAll(USER, SESSION);

    expect(await repo.findByUserAndSession(USER, SESSION)).toBeNull();
  });
});
