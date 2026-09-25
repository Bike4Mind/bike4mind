import { filterToolArtifactMarkup, type StreamChannel } from '@bike4mind/common';

/**
 * Helper function to handle tool result streaming for artifact-generating tools
 * This ensures tools like recharts that generate artifacts are streamed immediately
 * rather than waiting for recursive completion calls.
 *
 * Only the emitters in TOOL_ARTIFACT_EMITTERS stream, and only their pinned artifact type:
 * streamed text is parsed into reply artifacts, so any other tool's markup would render.
 *
 * What does stream is still a raw tool artifact rather than reply prose, so `streamCallback`
 * receives the channel tag and a public surface drops the text on that tag alone.
 */
export async function handleToolResultStreaming(
  toolName: string,
  toolResult: unknown,
  streamCallback: (results: string[], info: { channel: StreamChannel }) => Promise<void>
): Promise<void> {
  const filtered = filterToolArtifactMarkup(toolName, String(toolResult));

  if (filtered !== null) {
    await streamCallback([filtered], { channel: 'tool-artifact' });
  }
}
