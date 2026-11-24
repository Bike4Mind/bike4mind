// Each ALB condition block holds one match type, so the source IPs go in a block of their own,
// and only on rules that match a path. Header-matched rules pass through unchanged.
export function withDirectPathSourceIp<T extends object>(
  conditions: T[],
  cidrs: string[]
): Array<T | { sourceIp: { values: string[] } }> {
  return conditions.some(condition => 'pathPattern' in condition && condition.pathPattern)
    ? [...conditions, { sourceIp: { values: cidrs } }]
    : conditions;
}
