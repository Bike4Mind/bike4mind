export const isValidNotebookImportId = (importId: string): boolean => importId.length > 0 && !/[^0-9]/.test(importId);

const isValidUserId = (userId: string): boolean =>
  userId.length > 0 && userId !== '.' && userId !== '..' && !/[/\\\r\n]/.test(userId);

export const buildNotebookImportKeys = (userId: string, importId: string) => {
  if (!isValidUserId(userId) || !isValidNotebookImportId(importId)) {
    throw new Error('Invalid notebook import key');
  }
  const prefix = `notebooks/${userId}/${importId}`;
  return { dataKey: `${prefix}.json`, optionsKey: `${prefix}.options.json` };
};

export const parseNotebookImportKey = (key: string) => {
  const match = /^notebooks\/([^/]+)\/([0-9]+)\.json$/.exec(key);
  if (!match || match[0] !== key || !isValidUserId(match[1])) return null;
  const [, userId, importId] = match;
  return { userId, importId, ...buildNotebookImportKeys(userId, importId) };
};
