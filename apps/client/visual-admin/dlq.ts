const query = (data: unknown) => ({ data, isLoading: false, isError: false, refetch: () => {} });
export const useDlqQueues = () =>
  query([
    {
      label: 'fixture-worker',
      displayName: 'Background processing',
      application: 'Workers',
      approximateMessageCount: 3,
      approximateNotVisibleCount: 0,
      messageRetentionSeconds: 1209600,
      description: 'Failed background work awaiting an administrator review.',
      replay: 'side-effects',
      replayNote: 'May repeat external side effects. Review the recorded failure before replaying.',
      hasReplayDestination: true,
      owner: 'Platform operations',
    },
  ]);
export const useDlqMessages = () =>
  query([
    {
      messageId: 'transient-timeout-001',
      body: '{"operation":"process","entityId":"sample-record"}',
      sentTimestamp: String(Date.now() - 7200000),
      approximateReceiveCount: '4',
      failure: { category: 'timeout', errorMessage: 'Upstream request timed out after 30 seconds.' },
    },
    {
      messageId: 'invalid-payload-002',
      body: '{"operation":"process","entityId":null}',
      sentTimestamp: String(Date.now() - 86400000),
      approximateReceiveCount: '2',
      failure: { category: 'validation', errorMessage: 'Required entity identifier is missing.' },
    },
    {
      messageId: 'unknown-failure-003',
      body: '{"operation":"process"}',
      sentTimestamp: String(Date.now() - 3600000),
      approximateReceiveCount: '1',
    },
  ]);
export const useDlqHistory = () => query([]);
export const useDlqReplay = () => ({
  isPending: false,
  data: null,
  reset: () => {},
  mutateAsync: async () => {
    throw new Error('Visual fixture: writes are disabled');
  },
});
