import { ssrfSafeDownload } from '@bike4mind/fab-pipeline';
import { SLACK_MAX_FILE_SIZE_BYTES } from '@bike4mind/slack';

const ATTACHMENT_FETCH_TIMEOUT_MS = 30_000;

/**
 * Download the `slackFileUrl` an Atlassian attachment tool call carries. The URL is an LLM-supplied
 * tool argument, so it is fetched through the full SSRF guard rather than a bare `fetch`.
 * Shared by the web confirm route and the Slack pending-action executor.
 */
export async function downloadAttachmentUrl(url: string): Promise<Buffer> {
  const { data } = await ssrfSafeDownload(url, {
    maxBytes: SLACK_MAX_FILE_SIZE_BYTES,
    timeoutMs: ATTACHMENT_FETCH_TIMEOUT_MS,
  });
  return data;
}
