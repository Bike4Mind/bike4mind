import { getDynamicDataLakeAccess, lakeMembershipsFrom } from '../../../dataLakeService/getDynamicDataLakeTags';
import { unionPreauthorizedLakeAccess } from '../../../dataLakeService/unionPreauthorizedLakeAccess';
import type { AttachmentLakeAccess } from '@bike4mind/common';
import type { ToolContext } from './types';

/**
 * The caller's owner-wide data-lake access as an `AttachmentLakeAccess`, for a tool that must
 * re-authorize a workbench file by the SAME door that admitted it - `FabFileModel.findAccessibleInIds`
 * / `getAccessibleFiles`. Mirrors the chat door's `attachmentLakeAccess()` (getAccessibleDataLakeAccess):
 * owner-wide and NOT session-narrowed, so a file the caller reaches only through lake membership still
 * resolves. Deliberately differs from `resolveSessionLakeAccess`, which narrows to the session corpus.
 *
 * Fails safe: a lake-resolution outage degrades to ownership-only (empty access), never throws and
 * never widens - the same fail direction as the two doors it mirrors.
 *
 * `includeDraftLakes` is what makes this an ATTACHMENT scope rather than a retrieval one:
 * browse admits a draft lake's file to the workbench, so re-authorizing that same file here against
 * an active-only lake set would be narrower than the door that admitted it, and the tool would
 * report a file the user is looking at as not found. All three attachment doors pass it; no
 * retrieval surface does.
 */
export async function resolveAttachmentLakeAccess(context: ToolContext): Promise<AttachmentLakeAccess> {
  try {
    const resolved = await getDynamicDataLakeAccess(context, { includeDraftLakes: true });
    const unioned = await unionPreauthorizedLakeAccess(
      resolved,
      context.sessionPreauthorizedLakeIds,
      context.userId,
      context.db
    );
    return {
      lakeMemberships: lakeMembershipsFrom(unioned.lakes),
      dataLakeTags: unioned.dataLakeTags,
      dataLakeTagPrefixes: unioned.dataLakeTagPrefixes,
    };
  } catch {
    return {};
  }
}
