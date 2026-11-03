/**
 * Matches the JSON message field inside Lambda-prefixed logs, not caller-controlled metadata.
 * JSON selector syntax on purpose: CloudWatch Logs allows only five regex (%...%) metric
 * filters per log group, and the Next.js server group already carries more signals than that.
 */
export function messageFilterPattern(message: string): string {
  return `{ $.message = "${message}" }`;
}
