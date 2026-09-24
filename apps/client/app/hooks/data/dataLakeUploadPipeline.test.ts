import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';

const { apiPost, apiPut } = vi.hoisted(() => ({ apiPost: vi.fn(), apiPut: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: apiPost, put: apiPut, delete: vi.fn() } }));

import {
  classifyUploadError,
  foldersTagsForBatch,
  runWithConcurrency,
  canReuseRecoverableLake,
  syncRestoredLakeConfig,
  deleteFailedUploadOrphans,
  OFFLINE_MESSAGE,
  UPLOAD_ALL_FAILED_MESSAGE,
} from './dataLakeUploadPipeline';

const formValues = (overrides: Partial<Parameters<typeof syncRestoredLakeConfig>[1]> = {}) => ({
  name: 'Legal Docs',
  description: '',
  tagPrefix: 'legal:',
  requiredUserTag: '',
  requiredEntitlement: '',
  conflictResolution: 'skip' as const,
  ...overrides,
});

// Minimal axios-shaped error helper (axios.isAxiosError keys off this flag).
const axiosError = (status: number | undefined, data?: unknown, code?: string) => {
  const err = new axios.AxiosError('boom', code);
  if (status !== undefined) {
    err.response = { status, data } as never;
  }
  return err;
};

const CREATE = { config: { name: 'Legal Docs', tagPrefix: 'legal:' }, isAppend: false };

describe('classifyUploadError', () => {
  it('classifies offline/transport errors as network with the canonical message', () => {
    expect(classifyUploadError(new Error(OFFLINE_MESSAGE), CREATE)).toEqual({
      kind: 'network',
      message: OFFLINE_MESSAGE,
    });
    expect(classifyUploadError(axiosError(undefined, undefined, 'ERR_NETWORK'), CREATE).kind).toBe('network');
  });

  it('classifies the all-failed sentinel as upload', () => {
    expect(classifyUploadError(new Error(UPLOAD_ALL_FAILED_MESSAGE), CREATE).kind).toBe('upload');
  });

  it('re-derives a 422 culprit from the snapshot in create mode - short name', () => {
    const res = classifyUploadError(axiosError(422), { config: { name: '!', tagPrefix: 'legal:' }, isAppend: false });
    expect(res.kind).toBe('validation');
    expect(res.message).toContain('name is too short');
  });

  it('re-derives a 422 culprit - short prefix', () => {
    const res = classifyUploadError(axiosError(422), {
      config: { name: 'Legal Docs', tagPrefix: ':' },
      isAppend: false,
    });
    expect(res.kind).toBe('validation');
    expect(res.message).toContain('tag prefix is too short');
  });

  it('never blames name/prefix on a 422 in append mode', () => {
    const res = classifyUploadError(axiosError(422), { config: { name: '!', tagPrefix: ':' }, isAppend: true });
    expect(res.message).toBe('Your data lake settings were rejected. Review them and try again.');
  });

  it('maps 5xx to the server-problem message and surfaces a curated 4xx server message', () => {
    expect(classifyUploadError(axiosError(503), CREATE).kind).toBe('server');
    expect(classifyUploadError(axiosError(409, { error: 'Tag prefix already in use' }), CREATE).message).toBe(
      'Tag prefix already in use'
    );
  });

  it('passes through local Error messages and falls back for unknowns', () => {
    expect(classifyUploadError(new Error('No files to upload'), CREATE).message).toBe('No files to upload');
    expect(classifyUploadError(undefined, CREATE).message).toBe('Batch upload failed. Please try again.');
  });
});

describe('runWithConcurrency', () => {
  it('runs every item exactly once and never exceeds the limit', async () => {
    let active = 0;
    let peak = 0;
    const seen: number[] = [];
    await runWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async n => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 5));
      seen.push(n);
      active--;
    });
    expect(seen.toSorted((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it('resolves on an empty list and survives worker rejections', async () => {
    await expect(runWithConcurrency([], 4, async () => {})).resolves.toBeUndefined();
    const worker = vi.fn(async (n: number) => {
      if (n === 2) throw new Error('worker failure');
    });
    await expect(runWithConcurrency([1, 2, 3], 2, worker)).resolves.toBeUndefined();
    expect(worker).toHaveBeenCalledTimes(3);
  });

  it('cannot hang on a non-positive limit', async () => {
    const worker = vi.fn(async () => {});
    await expect(runWithConcurrency([1, 2, 3], 0, worker)).resolves.toBeUndefined();
    expect(worker).toHaveBeenCalledTimes(3);
  });
});

// The decision at the heart of the retry-reuse fix: reuse the lake a prior failed attempt archived only when
// this retry asks for the exact claim - prefix AND scope - that lake still holds.
describe('canReuseRecoverableLake', () => {
  it('reuses when the tag prefix matches exactly in the same personal scope', () => {
    expect(canReuseRecoverableLake({ id: 'lake1', tagPrefix: 'legal:' }, 'legal:', undefined)).toBe(true);
  });

  it('reuses when the tag prefix matches exactly in the same org scope', () => {
    expect(
      canReuseRecoverableLake({ id: 'lake1', tagPrefix: 'legal:', organizationId: 'org1' }, 'legal:', 'org1')
    ).toBe(true);
  });

  it('does not reuse when there is nothing remembered', () => {
    expect(canReuseRecoverableLake(null, 'legal:', undefined)).toBe(false);
  });

  it('does not reuse when the retry changed the tag prefix - nothing claims the new one', () => {
    expect(canReuseRecoverableLake({ id: 'lake1', tagPrefix: 'legal:' }, 'medical:', undefined)).toBe(false);
  });

  // Prefix claims are scoped per owner, so the same prefix in another scope is unclaimed - and
  // reusing across the switch would drop the retry's files into the wrong account entirely.
  it('does not reuse when the account switcher moved to an org between attempts', () => {
    expect(canReuseRecoverableLake({ id: 'lake1', tagPrefix: 'legal:' }, 'legal:', 'org1')).toBe(false);
  });

  it('does not reuse when the account switcher moved back to personal between attempts', () => {
    expect(
      canReuseRecoverableLake({ id: 'lake1', tagPrefix: 'legal:', organizationId: 'org1' }, 'legal:', undefined)
    ).toBe(false);
  });
});

/**
 * Request-shape guards for the two halves of the retry fix. The behaviour is driven end-to-end in
 * dataLakeWizard.test.ts; these pin the contract of the request itself, which is where a silent
 * regression would live - a dropped clear sentinel, or a resent counter that double-accounts.
 */
describe('syncRestoredLakeConfig', () => {
  beforeEach(() => {
    apiPut.mockReset().mockResolvedValue({ data: {} });
  });

  it('PUTs the editable Configure fields onto the reused lake', async () => {
    await syncRestoredLakeConfig('lake1', formValues({ description: 'described', requiredUserTag: 'LegalTeam' }));
    expect(apiPut).toHaveBeenCalledWith('/api/data-lakes/lake1', {
      name: 'Legal Docs',
      description: 'described',
      requiredUserTag: 'LegalTeam',
      requiredEntitlement: '',
    });
  });

  // '' is the server's clear sentinel on UPDATE, and omitting the key instead means "leave
  // unchanged" - so sending undefined would make a gate REMOVED between attempts silently persist.
  it('sends the empty-string clear sentinel rather than omitting a gate the user removed', async () => {
    await syncRestoredLakeConfig('lake1', formValues({ requiredUserTag: '', requiredEntitlement: '' }));
    const body = apiPut.mock.calls[0][1] as Record<string, unknown>;
    expect(body.requiredUserTag).toBe('');
    expect(body.requiredEntitlement).toBe('');
    expect('requiredUserTag' in body).toBe(true);
  });

  // The lake's prefix claim is the thing the reuse depends on; changing it here would move the
  // claim out from under the batch that is about to upload into it.
  it('never sends the tag prefix', async () => {
    await syncRestoredLakeConfig('lake1', formValues());
    expect(apiPut.mock.calls[0][1]).not.toHaveProperty('fileTagPrefix');
    expect(apiPut.mock.calls[0][1]).not.toHaveProperty('tagPrefix');
  });
});

describe('deleteFailedUploadOrphans', () => {
  beforeEach(() => {
    apiPost.mockReset().mockResolvedValue({ data: { success: true } });
  });

  it('posts only the ids, so the batch counters the caller already stamped are not re-sent', async () => {
    await deleteFailedUploadOrphans('batch1', ['id-a', 'id-b']);
    expect(apiPost).toHaveBeenCalledWith('/api/data-lakes/batches/upload-complete', {
      batchId: 'batch1',
      failedFileIds: ['id-a', 'id-b'],
    });
    const body = apiPost.mock.calls[0][1] as Record<string, unknown>;
    expect(body).not.toHaveProperty('failedFiles');
    expect(body).not.toHaveProperty('failedFileNames');
  });

  it('does nothing when there is no batch or nothing to clean up', async () => {
    await deleteFailedUploadOrphans(undefined, ['id-a']);
    await deleteFailedUploadOrphans('batch1', []);
    expect(apiPost).not.toHaveBeenCalled();
  });

  // Best-effort: it runs on a rollback path, so a cleanup failure must not replace the error the
  // user actually needs to read.
  it('swallows a failure rather than masking the error being rolled back', async () => {
    apiPost.mockRejectedValue(new Error('cleanup failed'));
    await expect(deleteFailedUploadOrphans('batch1', ['id-a'])).resolves.toBeUndefined();
  });
});

describe('foldersTagsForBatch', () => {
  it('unions folder tags across files without duplicates', () => {
    const tags = foldersTagsForBatch(
      [{ relativePath: 'legal/contracts/a.pdf' }, { relativePath: 'legal/contracts/b.pdf' }],
      'legal:'
    );
    const names = tags.map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThan(0);
  });

  it('normalizes a stored prefix that carries edge whitespace (#2467)', () => {
    // runUploadPipeline already trims via submittedTagPrefix before it reaches this helper, so
    // this pins the belt rather than the braces: foldersTagsForBatch is exported and callable
    // with a lake's raw fileTagPrefix, and a row predating the create schema's trim can hold
    // " legal: ". The name it builds has to be the trimmed one either way, since that is the
    // form the read arms and the apply door both match on (#2467).
    expect(foldersTagsForBatch([{ relativePath: 'legal/contracts/a.pdf' }], ' legal: ')).toEqual(
      foldersTagsForBatch([{ relativePath: 'legal/contracts/a.pdf' }], 'legal:')
    );
  });
});
