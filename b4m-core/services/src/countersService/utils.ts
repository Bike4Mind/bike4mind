// Utility functions for counter service that are safe for browser use
export function calculatePercentageChange(current: number, previous: number): number {
  if (previous === 0) {
    return current > 0 ? Math.round(current * 10000) / 100 : 0; // e.g., 0 to 3 = 300.00% increase
  }
  return Math.round(((current - previous) / previous) * 10000) / 100; // Round to 2 decimal places
}

export function formatPercentage(value: number): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}
