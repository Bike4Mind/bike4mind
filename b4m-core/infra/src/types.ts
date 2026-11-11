export interface DlqDescriptor {
  /** Short kebab-case label used in alarm names and registry lookups */
  label: string;
  /** Human-readable name for UI and dashboard widget titles */
  displayName: string;
  /** Value of Application tag for CloudWatch grouping */
  application: string;
  /** Null when recovery has no SQS replay destination. */
  sourceQueue: string | null;
  replay?: 'safe' | 'side-effects' | 'unsafe';
}

export interface DlqResolvers {
  /** Returns undefined if URL not bound. Factory normalizes to friendly error. */
  resolveDlqUrl(label: string): string | undefined;
  resolveSourceQueueUrl(name: string): string | undefined;
}

export interface CreateDlqRegistryOptions {
  /** Appended to "Missing DLQ URL for label: <label>." - ops-grep hint. */
  dlqErrorContext?: string;
  /** Appended to "Missing source queue URL for: <name>." - ops-grep hint. */
  sourceQueueErrorContext?: string;
}
