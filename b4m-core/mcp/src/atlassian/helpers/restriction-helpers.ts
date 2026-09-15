/**
 * Atlassian MCP Server - Restriction Helper Functions
 *
 * Shared helper functions for Confluence page restriction operations (add/remove).
 */

import { ConfluenceApi, getErrorMessage } from '@bike4mind/common';
import { createPreviewResponse } from '../../shared/confirmation-helpers.js';
import { CONFLUENCE_ADD_PAGE_RESTRICTION, CONFLUENCE_REMOVE_PAGE_RESTRICTION } from '../constants.js';
import type { RestrictionItem } from './schemas.js';

/**
 * Fetch display-friendly info for Confluence page restriction previews (supports bulk).
 * Returns page title, space name, and enriched restrictions with display names.
 */
export async function getBulkRestrictionPreviewDisplayInfo(
  params: {
    pageId: string;
    restrictions: RestrictionItem[];
  },
  getConfluenceApi: () => ConfluenceApi
): Promise<{
  displayPageTitle: string;
  displaySpaceName: string;
  enrichedRestrictions: Array<RestrictionItem & { displaySubjectName: string }>;
}> {
  const { pageId, restrictions } = params;
  const api = getConfluenceApi();

  let displayPageTitle = pageId;
  let displaySpaceName = '';

  // Fetch page and space info
  try {
    const pageInfo = await api.getPage({ pageId, includeContent: false });
    displayPageTitle = pageInfo.title || pageId;

    // Fetch space name if we have spaceId
    if (pageInfo.spaceId) {
      try {
        const spaceInfo = await api.getSpaceById({ spaceId: pageInfo.spaceId });
        displaySpaceName = spaceInfo.name || pageInfo.spaceId;
      } catch {
        displaySpaceName = pageInfo.spaceId;
      }
    }
  } catch {
    // Fall back to pageId if we can't fetch page info
  }

  // Fetch display names for all subjects in parallel
  const enrichedRestrictions = await Promise.all(
    restrictions.map(async restriction => {
      let displaySubjectName = restriction.subject;

      try {
        if (restriction.restrictionType === 'user') {
          const userInfo = await api.validateUserExists(restriction.subject);
          displaySubjectName = userInfo.displayName || restriction.subject;
        } else {
          const groupInfo = await api.validateGroupExists(restriction.subject);
          displaySubjectName = groupInfo.name || restriction.subject;
        }
      } catch {
        // Fall back to raw subject if lookup fails
      }

      return { ...restriction, displaySubjectName };
    })
  );

  return { displayPageTitle, displaySpaceName, enrichedRestrictions };
}

/**
 * Normalize restriction parameters to array format
 * Supports both single (operation, restrictionType, subject) and bulk (restrictions array) modes
 */
export function normalizeRestrictions(params: {
  operation?: string;
  restrictionType?: string;
  subject?: string;
  restrictions?: RestrictionItem[];
}): RestrictionItem[] | { error: string } {
  if (params.restrictions && params.restrictions.length > 0) {
    // Bulk mode
    return params.restrictions;
  } else if (params.operation && params.restrictionType && params.subject) {
    // Single mode (backward compatible)
    return [
      {
        operation: params.operation as RestrictionItem['operation'],
        restrictionType: params.restrictionType as RestrictionItem['restrictionType'],
        subject: params.subject,
      },
    ];
  } else {
    return {
      error: 'Must provide either (operation, restrictionType, subject) or restrictions array.',
    };
  }
}

/**
 * Check if a restriction exists in the current page restrictions
 */
function restrictionExists(
  currentRestrictions: {
    restrictions: Array<{ operation: string; subjects: Array<{ type: string; identifier: string }> }>;
  },
  restriction: RestrictionItem
): boolean {
  const operationRestriction = currentRestrictions.restrictions.find(r => r.operation === restriction.operation);
  if (!operationRestriction) return false;

  return operationRestriction.subjects.some(
    s => s.type === restriction.restrictionType && s.identifier === restriction.subject
  );
}

/**
 * Create preview response for restriction operations
 * Validates restrictions against current state before showing preview
 */
export async function createRestrictionPreview(params: {
  pageId: string;
  restrictions: RestrictionItem[];
  tool: typeof CONFLUENCE_ADD_PAGE_RESTRICTION | typeof CONFLUENCE_REMOVE_PAGE_RESTRICTION;
  action: 'add' | 'remove';
  getConfluenceApi: () => ConfluenceApi;
}): Promise<ReturnType<typeof createPreviewResponse>> {
  const { pageId, restrictions, tool, action, getConfluenceApi } = params;
  const api = getConfluenceApi();
  const isAdd = action === 'add';
  const emoji = isAdd ? '🔒' : '🔓';
  const actionText = isAdd ? 'Add' : 'Remove';

  // Fetch current restrictions to validate the request
  const currentRestrictions = await api.getPageRestrictions({ pageId });

  // Filter restrictions based on current state
  // For "add": filter out restrictions that already exist
  // For "remove": filter out restrictions that don't exist
  const validRestrictions: RestrictionItem[] = [];
  const skippedRestrictions: Array<RestrictionItem & { reason: string }> = [];

  for (const restriction of restrictions) {
    const exists = restrictionExists(currentRestrictions, restriction);

    if (isAdd && exists) {
      skippedRestrictions.push({
        ...restriction,
        reason: `already has ${restriction.operation} access`,
      });
    } else if (!isAdd && !exists) {
      skippedRestrictions.push({
        ...restriction,
        reason: `does not have ${restriction.operation} restriction to remove`,
      });
    } else {
      validRestrictions.push(restriction);
    }
  }

  // If no valid restrictions remain, return early with a message
  if (validRestrictions.length === 0) {
    // Fetch page info for better message
    let displayPageTitle = pageId;
    try {
      const pageInfo = await api.getPage({ pageId, includeContent: false });
      displayPageTitle = pageInfo.title || pageId;
    } catch {
      // Fall back to pageId
    }

    // Enrich skipped restrictions with display names
    const enrichedSkipped = await Promise.all(
      skippedRestrictions.map(async r => {
        let displayName = r.subject;
        try {
          if (r.restrictionType === 'user') {
            const userInfo = await api.validateUserExists(r.subject);
            displayName = userInfo.displayName || r.subject;
          } else {
            const groupInfo = await api.validateGroupExists(r.subject);
            displayName = groupInfo.name || r.subject;
          }
        } catch {
          // Fall back to raw subject
        }
        return { ...r, displayName };
      })
    );

    const skippedMessages = enrichedSkipped.map(r => `• ${r.displayName} ${r.reason}`).join('\n');

    const message = isAdd
      ? `ℹ️ No restrictions to add on "${displayPageTitle}".\n\nAll requested users/groups already have the specified access:\n${skippedMessages}`
      : `ℹ️ No restrictions to remove from "${displayPageTitle}".\n\nThe specified restrictions don't exist:\n${skippedMessages}`;

    return {
      content: [{ type: 'text' as const, text: message }],
    };
  }

  const note = isAdd
    ? 'Adding any restriction makes the page explicitly restricted (no longer inherits from parent).'
    : 'If all restrictions are removed, the page will inherit permissions from parent.';

  // Fetch display-friendly info for preview (only for valid restrictions)
  const { displayPageTitle, displaySpaceName, enrichedRestrictions } = await getBulkRestrictionPreviewDisplayInfo(
    {
      pageId,
      restrictions: validRestrictions,
    },
    getConfluenceApi
  );

  // Build additional note if some restrictions were skipped
  let finalNote = note;
  if (skippedRestrictions.length > 0) {
    const enrichedSkipped = await Promise.all(
      skippedRestrictions.map(async r => {
        let displayName = r.subject;
        try {
          if (r.restrictionType === 'user') {
            const userInfo = await api.validateUserExists(r.subject);
            displayName = userInfo.displayName || r.subject;
          }
        } catch {
          // Fall back to raw subject
        }
        return { ...r, displayName };
      })
    );

    const skippedList = enrichedSkipped.map(r => `${r.displayName} (${r.reason})`).join(', ');
    finalNote = `${note}\n\nSkipped: ${skippedList}`;
  }

  return createPreviewResponse(
    validRestrictions.length === 1
      ? `${emoji} Preview: ${actionText} Confluence Page Restriction`
      : `${emoji} Preview: ${actionText} ${validRestrictions.length} Confluence Page Restrictions`,
    {
      pageId,
      restrictionCount: validRestrictions.length,
      note: finalNote,
    },
    'restriction',
    {
      tool,
      params: {
        pageId,
        restrictions: enrichedRestrictions.map(r => ({
          operation: r.operation,
          restrictionType: r.restrictionType,
          subject: r.subject,
          display_subject_name: r.displaySubjectName,
        })),
        display_page_title: displayPageTitle,
        display_space_name: displaySpaceName,
      },
    }
  );
}

/**
 * Execute restriction operations (add or remove)
 */
export async function executeRestrictionOperation(params: {
  pageId: string;
  restrictions: RestrictionItem[];
  action: 'add' | 'remove';
  getConfluenceApi: () => ConfluenceApi;
}): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const { pageId, restrictions, action, getConfluenceApi } = params;
  const api = getConfluenceApi();

  try {
    const results = await Promise.all(
      restrictions.map(r =>
        action === 'add'
          ? api.addPageRestriction({
              pageId,
              operation: r.operation,
              restrictionType: r.restrictionType,
              subject: r.subject,
            })
          : api.removePageRestriction({
              pageId,
              operation: r.operation,
              restrictionType: r.restrictionType,
              subject: r.subject,
            })
      )
    );

    const successCount = results.filter(r => r.success).length;
    const summary = {
      success: true,
      totalRequested: restrictions.length,
      successCount,
      failedCount: restrictions.length - successCount,
      results,
    };

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(summary, null, 2) }],
    };
  } catch (error) {
    return {
      content: [{ type: 'text' as const, text: `Error: ${getErrorMessage(error)}` }],
      isError: true,
    };
  }
}
