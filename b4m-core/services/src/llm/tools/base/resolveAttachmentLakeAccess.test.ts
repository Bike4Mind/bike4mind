import { describe, it, expect, vi, beforeEach } from 'vitest';

const getDynamicDataLakeAccessMock = vi.fn();
const lakeMembershipsFromMock = vi.fn();
vi.mock('../../../dataLakeService/getDynamicDataLakeTags', () => ({
  getDynamicDataLakeAccess: (...args: unknown[]) => getDynamicDataLakeAccessMock(...args),
  lakeMembershipsFrom: (...args: unknown[]) => lakeMembershipsFromMock(...args),
}));

const unionPreauthorizedLakeAccessMock = vi.fn();
vi.mock('../../../dataLakeService/unionPreauthorizedLakeAccess', () => ({
  unionPreauthorizedLakeAccess: (...args: unknown[]) => unionPreauthorizedLakeAccessMock(...args),
}));

import { resolveAttachmentLakeAccess } from './resolveAttachmentLakeAccess';
import type { ToolContext } from './types';

const MEMBERSHIP = {
  kind: 'owned' as const,
  datalakeTag: 'datalake:acme',
  fileTagPrefix: 'acme:',
  creatorUserId: 'creator-1',
};

const context = { userId: 'u1', db: {} } as unknown as ToolContext;

describe('resolveAttachmentLakeAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDynamicDataLakeAccessMock.mockResolvedValue({ lakes: [{ id: 'l1' }] });
    unionPreauthorizedLakeAccessMock.mockImplementation(async (resolved: { lakes: unknown[] }) => ({
      ...resolved,
      dataLakeTags: ['datalake:acme'],
      dataLakeTagPrefixes: ['reg:'],
    }));
    lakeMembershipsFromMock.mockReturnValue([MEMBERSHIP]);
  });

  // Browse (`GET /api/files/byIds`) admits a DRAFT lake's file to the workbench. A tool
  // re-authorizing that same named file against an active-only lake set would be narrower than the
  // door that admitted it, so `edit_image` would report "not found or is not accessible" for a file
  // the user is looking at.
  it('asks for the attachment scope, not the retrieval one', async () => {
    await resolveAttachmentLakeAccess(context);

    expect(getDynamicDataLakeAccessMock).toHaveBeenCalledWith(context, { includeDraftLakes: true });
  });

  it('passes the context object through by IDENTITY, so the turn keeps its resolution memos', async () => {
    // The reason `includeDraftLakes` is a per-call option rather than a context field: the
    // membership/grant/supersession memos key on this object's identity, and a spread copy would
    // silently re-read them against a possibly different snapshot.
    await resolveAttachmentLakeAccess(context);

    expect(getDynamicDataLakeAccessMock.mock.calls[0][0]).toBe(context);
  });

  it('builds lakeMemberships through lakeMembershipsFrom and forwards the tag buckets', async () => {
    const access = await resolveAttachmentLakeAccess(context);

    expect(lakeMembershipsFromMock).toHaveBeenCalledWith([{ id: 'l1' }]);
    expect(access).toEqual({
      lakeMemberships: [MEMBERSHIP],
      dataLakeTags: ['datalake:acme'],
      dataLakeTagPrefixes: ['reg:'],
    });
  });

  it('degrades to ownership-only when resolution throws, never widening', async () => {
    getDynamicDataLakeAccessMock.mockRejectedValue(new Error('lake read failed'));

    expect(await resolveAttachmentLakeAccess(context)).toEqual({});
  });
});
