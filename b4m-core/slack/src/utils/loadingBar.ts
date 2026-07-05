/**
 * Helper function to create a visual loading bar for status updates
 * @param percentage - Progress percentage (0-100)
 * @param width - Width of the loading bar in characters (default: 10)
 * @returns A string representing the loading bar, e.g., "[████░░░░░░]"
 */
export function createLoadingBar(percentage: number, width: number = 10): string {
  const filled = Math.round((percentage / 100) * width);
  const empty = width - filled;
  const filledBar = '█'.repeat(filled);
  const emptyBar = '░'.repeat(empty);
  return `[${filledBar}${emptyBar}]`;
}
