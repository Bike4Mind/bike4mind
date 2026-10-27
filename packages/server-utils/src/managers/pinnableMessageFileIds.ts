/** The message attachments to pin: every one except those scoped to the message only. */
export const pinnableMessageFileIds = (messageFileIds?: string[], messageOnlyFileIds?: string[]): string[] => {
  const messageOnly = new Set((messageOnlyFileIds ?? []).map(id => id.toLowerCase()));
  return (messageFileIds ?? []).filter(id => !messageOnly.has(id.toLowerCase()));
};
