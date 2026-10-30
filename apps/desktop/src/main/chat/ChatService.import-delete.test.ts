import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AttachmentStore } from './AttachmentStore';
import { ChatService } from './ChatService';
import { SessionStore } from './SessionStore';
import { AccessStore } from './tools/AccessStore';

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'import-delete-'));
  const logger = { debug: vi.fn(), warn: vi.fn() };
  const store = new SessionStore(join(root, 'sessions'), 'model');
  const attachments = new AttachmentStore(join(root, 'attachments'), logger);
  const sessionId = 'cc-imported';
  const added = await attachments.add(sessionId, [
    { source: 'bytes', name: 'notes.txt', mediaType: 'text/plain', data: Buffer.from('keep these bytes') },
  ]);
  await store.putImported({
    id: sessionId,
    title: 'Imported',
    model: 'model',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    mode: 'chat',
    approvalMode: 'ask',
    reasoningEffort: 'default',
    importOrigin: { kind: 'claude-code', sourceId: 'original', importedAt: 'x', sourceUpdatedAt: 'x' },
    messages: [{ id: 'cc-original', role: 'user', content: 'hello', createdAt: 'x', attachments: added.attachments }],
  });
  const service = new ChatService({
    store,
    attachments,
    access: new AccessStore(join(root, 'access.json')),
    logger,
    getApiClient: () => null,
    getEnvironmentUrl: () => 'http://localhost:3000',
    emit: () => {},
  });
  return { store, service, attachments, sessionId, attachmentId: added.attachments[0].id };
}

describe('ChatService imported session removal', () => {
  it('keeps attachments when the atomic guard finds a continued conversation', async () => {
    const { store, service, attachments, sessionId, attachmentId } = await setup();
    await store.appendMessage(sessionId, { id: 'my-turn', role: 'user', content: 'continued', createdAt: 'x' });
    expect(await service.deleteImportedSession(sessionId, 'scope')).toBe('forked');
    expect(await store.get(sessionId)).not.toBeNull();
    expect((await attachments.read(sessionId, attachmentId))?.toString()).toBe('keep these bytes');
  });

  it('cleans attachments after the atomic guard removes an imported conversation', async () => {
    const { store, service, attachments, sessionId, attachmentId } = await setup();
    expect(await service.deleteImportedSession(sessionId, 'scope')).toBe('removed');
    expect(await store.get(sessionId)).toBeNull();
    expect(await attachments.read(sessionId, attachmentId)).toBeNull();
  });
});
