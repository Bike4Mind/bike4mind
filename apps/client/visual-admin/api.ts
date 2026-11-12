export const api = {
  get: async () => ({
    data: {
      brief: {
        day: '2026-11-12',
        generatedAt: '2026-11-12T05:00:00Z',
        environment: 'fixture',
        delivery: 'sent',
        facts:
          'Queues waiting: Feedback 3 (oldest 2 days). Dead letters 3 (oldest 1 day).\nAI handled: 8 suggestions accepted; 2 need review.\nUnresolved alarms: 1.\nKnown AI spend: $4.20 of $5.00 monthly cap.',
        summary: null,
        needsHuman: [
          { label: 'Review feedback', href: '/admin?tab=2' },
          { label: 'Inspect dead letters', href: '/admin?tab=40' },
        ],
      },
    },
  }),
};
