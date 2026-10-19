/**
 * Shared GitHub Label Definitions
 *
 * Centralized label definitions used by both LiveOps Triage and Context Telemetry systems.
 * This ensures consistency across automated issue creation and allows fixes to be shared.
 */

/**
 * GitHub label definition with color and description
 */
export interface GitHubLabelDef {
  name: string;
  color: string;
  description: string;
}

// Priority labels (shared by both systems)

export const PRIORITY_LABELS: GitHubLabelDef[] = [
  { name: 'P0', color: 'd73a4a', description: 'Priority P0 - Critical' },
  { name: 'P1', color: 'ff7518', description: 'Priority P1 - High' },
  { name: 'P2', color: 'fbca04', description: 'Priority P2 - Medium' },
  { name: 'P3', color: '0e8a16', description: 'Priority P3 - Low' },
];

// Common labels (shared by both systems)

export const COMMON_LABELS: GitHubLabelDef[] = [
  { name: 'bug', color: 'd73a4a', description: "Something isn't working" },
  { name: 'regression', color: 'b60205', description: 'Bug that reoccurred after being fixed' },
];

// System-specific labels

export const LIVEOPS_LABELS: GitHubLabelDef[] = [
  { name: 'liveops', color: 'f9d0c4', description: 'Automated LiveOps triage' },
];

export const TELEMETRY_LABELS: GitHubLabelDef[] = [
  { name: 'telemetry', color: 'c5def5', description: 'Automated context telemetry alert' },
];

// Combined label sets (for each system's health checks)

/**
 * All labels required for LiveOps triage issue creation.
 * Used by health checks and issue creation.
 */
export const REQUIRED_LIVEOPS_LABELS: GitHubLabelDef[] = [...COMMON_LABELS, ...PRIORITY_LABELS, ...LIVEOPS_LABELS];

/**
 * All labels required for Context Telemetry issue creation.
 * Used by health checks and issue creation.
 */
export const REQUIRED_TELEMETRY_LABELS: GitHubLabelDef[] = [...COMMON_LABELS, ...PRIORITY_LABELS, ...TELEMETRY_LABELS];

// Helper functions

/**
 * Get a label definition by name.
 * Searches across all label types (common, priority, liveops, telemetry).
 *
 * @param name - The label name to look up
 * @returns The label definition or undefined if not found
 */
export function getLabelDef(name: string): GitHubLabelDef | undefined {
  const allLabels = [...COMMON_LABELS, ...PRIORITY_LABELS, ...LIVEOPS_LABELS, ...TELEMETRY_LABELS];
  return allLabels.find(l => l.name === name);
}

/**
 * Get priority label names as an array.
 * Useful for filtering issues by priority.
 */
export function getPriorityLabelNames(): string[] {
  return PRIORITY_LABELS.map(l => l.name);
}

/**
 * Check if a label name is a valid priority label (P0-P3).
 */
export function isPriorityLabel(name: string): name is 'P0' | 'P1' | 'P2' | 'P3' {
  return ['P0', 'P1', 'P2', 'P3'].includes(name);
}

/**
 * Priority type for type-safe priority handling.
 */
export type Priority = 'P0' | 'P1' | 'P2' | 'P3';
