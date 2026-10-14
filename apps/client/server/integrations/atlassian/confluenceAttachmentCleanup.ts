import type { Logger } from '@bike4mind/observability';
import { ConfluenceApi, isValidConfluencePageId } from '@bike4mind/common';
import { buildAtlassianConfig } from '@bike4mind/common/atlassian/config';

/**
 * Remove Confluence storage format macros that reference a specific attachment.
 * Handles both <ac:image> tags and <ac:structured-macro ac:name="view-file"> tags.
 */
export function removeAttachmentMacros(content: string, filename: string): string {
  const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Remove <ac:image> tags referencing the attachment (optionally wrapped in <p>)
  const imageRegex = new RegExp(
    `(?:<p>\\s*)?<ac:image[^>]*>[\\s\\S]*?<ri:attachment[^>]*ri:filename="${escaped}"[^/]*/?>\\s*</ac:image>(?:\\s*</p>)?`,
    'g'
  );
  // Remove <ac:structured-macro ac:name="view-file"> tags referencing the attachment
  const macroRegex = new RegExp(
    `<ac:structured-macro[^>]*ac:name="view-file"[^>]*>[\\s\\S]*?<ri:attachment[^>]*ri:filename="${escaped}"[^/]*/?>` +
      `[\\s\\S]*?</ac:structured-macro>`,
    'g'
  );
  let cleaned = content.replace(imageRegex, '');
  cleaned = cleaned.replace(macroRegex, '');
  return cleaned;
}

/**
 * After deleting a Confluence attachment, clean up the page content
 * to remove inline macros (image previews, view-file macros) that reference it.
 */
export async function cleanupConfluencePageContent(
  envVariables: Array<{ key: string; value: string }>,
  pageId: string,
  filename: string,
  logger: Logger
): Promise<void> {
  if (!isValidConfluencePageId(pageId)) {
    logger.warn('[Confluence Cleanup] Invalid page id, skipping page cleanup');
    return;
  }

  const getEnv = (name: string) => envVariables.find(v => v.key === name)?.value || '';
  const accessToken = getEnv('ATLASSIAN_ACCESS_TOKEN');
  const cloudId = getEnv('ATLASSIAN_CLOUD_ID');

  if (!accessToken || !cloudId) {
    logger.warn('[Confluence Cleanup] Missing credentials, skipping page cleanup');
    return;
  }

  const config = buildAtlassianConfig({ accessToken, cloudId, siteUrl: getEnv('ATLASSIAN_SITE_URL') });
  const confluence = new ConfluenceApi(config.confluence);

  const page = await confluence.getPageStorage({ pageId });
  if (!page.storage) {
    logger.info('[Confluence Cleanup] Page has no storage content to clean');
    return;
  }

  const cleanedContent = removeAttachmentMacros(page.storage, filename);
  if (cleanedContent === page.storage) {
    logger.info('[Confluence Cleanup] No macros found referencing deleted attachment');
    return;
  }

  // expectedVersion makes Confluence reject the write if the page was edited since the read above.
  await confluence.updatePage({
    pageId,
    title: page.title,
    content: cleanedContent,
    expectedVersion: page.version,
  });

  logger.info(`[Confluence Cleanup] Removed macros for "${filename}" from page ${pageId}`);
}
