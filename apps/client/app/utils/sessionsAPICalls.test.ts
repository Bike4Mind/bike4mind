import { beforeEach, describe, expect, it, vi } from 'vitest';

const put = vi.fn().mockResolvedValue({ data: {} });
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { put: (...args: unknown[]) => put(...args) } }));

import { setSessionIncludeLibraryFiles, updateSessionToServer } from './sessionsAPICalls';

describe('includeLibraryFiles on the session PUT', () => {
  beforeEach(() => put.mockClear());

  it('strips a whole-session echo of the flag, so a rename cannot overwrite a newer toggle', async () => {
    await updateSessionToServer({ id: 's1', name: 'renamed', includeLibraryFiles: false });
    expect(put).toHaveBeenCalledWith('/api/sessions/s1', { id: 's1', name: 'renamed' });
  });

  it('sends a deliberate choice under the stored name, over any echoed value', async () => {
    await updateSessionToServer({ id: 's1', includeLibraryFiles: true, includeLibraryFilesChoice: false });
    expect(put).toHaveBeenCalledWith('/api/sessions/s1', { id: 's1', includeLibraryFiles: false });
  });

  it('sends exactly the flag from the dedicated setter', async () => {
    await setSessionIncludeLibraryFiles('s1', true);
    expect(put).toHaveBeenCalledWith('/api/sessions/s1', { includeLibraryFiles: true });
  });
});
