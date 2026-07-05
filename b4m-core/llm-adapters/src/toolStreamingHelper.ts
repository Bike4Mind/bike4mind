/**
 * Helper function to handle tool result streaming for artifact-generating tools
 * This ensures tools like recharts that generate artifacts are streamed immediately
 * rather than waiting for recursive completion calls.
 */
export async function handleToolResultStreaming(
  toolName: string,
  toolResult: any,
  streamCallback: (results: string[]) => Promise<void>
): Promise<void> {
  const resultString = toolResult.toString();

  // Check if this is an artifact-generating tool that should be streamed immediately
  const shouldStream =
    toolName === 'recharts' ||
    resultString.includes('<artifact') ||
    resultString.includes('type="application/vnd.ant.') ||
    resultString.includes('type="application/vnd.b4m.');

  if (shouldStream) {
    await streamCallback([resultString]);
  }
}
