import { describe, it, expect, vi } from 'vitest';
import axios from 'axios';
import {
  classifyUploadError,
  foldersTagsForBatch,
  runWithConcurrency,
  canReuseRecoverableLake,
  OFFLINE_MESSAGE,
  UPLOAD_ALL_FAILED_MESSAGE,
} from './dataLakeUploadPipeline';

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
