/** Matches the JSON message field inside Lambda-prefixed logs, not caller-controlled metadata. */
export function messageFilterPattern(message: string): string {
  return `%\\x22message\\x22:\\x22${message}\\x22%`;
}
