export const getFeedbackHistoryFromServer = async () => ({
  items: [
    {
      id: 'note-1',
      author: 'Fixture admin',
      occurredAt: '2026-11-12T05:00:00Z',
      note: 'Reproduced on a compact screen. Follow up with the reporter after verification.',
    },
    {
      id: 'status-1',
      author: 'Fixture admin',
      occurredAt: '2026-11-11T05:00:00Z',
      summary: 'Report closed after review.',
      changes: [{ field: 'resolution', before: null, after: 'fixed' }],
    },
  ],
  nextCursor: null,
});
export const addFeedbackNoteOnServer = async () => {
  throw new Error('Visual fixture: writes are disabled');
};
