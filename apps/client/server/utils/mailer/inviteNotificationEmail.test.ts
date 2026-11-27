import { InviteType } from '@bike4mind/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { publish } = vi.hoisted(() => ({ publish: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/eventBus', () => ({ EmailEvents: { Send: { publish } } }));

import { getInviteTypeName, sendInviteNotificationEmails } from './inviteNotificationEmail';

const send = (type: InviteType, documentName: string) =>
  sendInviteNotificationEmails(
    ['invitee@example.com'],
    'Ada Owner',
    'ada@example.com',
    documentName,
    getInviteTypeName(type),
    'https://app.example.com/invite/abc'
  );

describe('sendInviteNotificationEmails', () => {
  beforeEach(() => {
    publish.mockReset();
    publish.mockResolvedValue(undefined);
  });

  it('names the team in a team invite subject and body', async () => {
    await send(InviteType.Organization, 'Platform Crew');
    const [{ subject, body }] = publish.mock.calls[0];
    expect(subject).toContain('Ada Owner invited you to join Platform Crew');
    expect(body).toContain('invited you to join the team <strong>Platform Crew</strong>');
    expect(body).toContain('<strong>Team:</strong> Platform Crew');
    expect(body).not.toContain('shared a organization');
  });

  it('keeps line breaks in a team name out of the subject', async () => {
    await send(InviteType.Organization, 'Platform\r\nBcc: x@example.com');
    const [{ subject }] = publish.mock.calls[0];
    expect(subject).not.toMatch(/[\r\n]/);
  });

  it('escapes the team name in the body', async () => {
    await send(InviteType.Organization, '<b>Crew</b>');
    const [{ body }] = publish.mock.calls[0];
    expect(body).toContain('&lt;b&gt;Crew&lt;/b&gt;');
  });

  it('keeps the shared-item copy for other invite types', async () => {
    await send(InviteType.Project, 'Roadmap');
    const [{ subject, body }] = publish.mock.calls[0];
    expect(subject).toContain('Ada Owner shared a project with you');
    expect(body).toContain('<strong>Project:</strong> Roadmap');
  });
});
