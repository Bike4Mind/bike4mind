import { expect, it, vi } from 'vitest';
const record = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/server-utils/utils/organizationAudit', () => ({ recordOrganizationAuditEventSafe: record }));
import { logConnectionCreated } from './githubConnectionAuditLog';

it('waits for persistence before completing the connector audit', async () => {
  let release!: () => void;
  record.mockReturnValue(
    new Promise<void>(resolve => {
      release = resolve;
    })
  );
  let completed = false;
  const pending = logConnectionCreated({
    organizationId: 'org',
    actorUserId: 'actor',
    connectionId: 'connection',
  }).then(() => {
    completed = true;
  });
  await Promise.resolve();
  expect(completed).toBe(false);
  expect(record).toHaveBeenCalledWith({
    organizationId: 'org',
    actorUserId: 'actor',
    targetId: 'connection',
    action: 'connector.connected',
  });
  release();
  await pending;
  expect(completed).toBe(true);
});
