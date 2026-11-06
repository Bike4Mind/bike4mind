import { describe, expect, it } from 'vitest';
import { sessionToCSV, type ExportableSession } from './sessionExport';

describe('sessionToCSV', () => {
  it('prefixes message content that starts with a formula character', () => {
    const session: ExportableSession = {
      id: 's1',
      name: 'Session',
      createdAt: new Date(0),
      updatedAt: new Date(0),
      messages: [{ timestamp: new Date(0), role: 'user', content: '=SUM(A1)\nnext' }],
    };
    expect(sessionToCSV(session)).toContain(`"'=SUM(A1)\nnext"`);
  });
});
