import type { ComponentImpact, ComponentState, DisplayState, OverallImpact, VendorIndicator } from './stateOrder';
import type { IncidentKind, IncidentStatus } from './isActive';

export const STATUS_SCHEMA_VERSION = 1;
export const STATUS_STALE_AFTER_SECONDS = 240;
export const STATUS_HARD_STALE_AFTER_SECONDS = 900;
export const STATUS_UPTIME_WINDOW_DAYS = 90;
export const UPCOMING_MAINTENANCE_DAYS = 7;

/** Incident ids are random and carry no prefix or time component. */
export const PUBLIC_INCIDENT_ID_PATTERN = /^[a-z0-9]{10}$/;
export const PUBLIC_SLUG_PATTERN = /^[a-z][a-z0-9-]{2,40}$/;
/** No path separator, so a full journal key can never pass as its nonce. */
export const JOURNAL_NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
export const PUBLIC_UPDATE_ID_PATTERN = /^u_[A-Za-z0-9_-]{1,64}$/;

export const TEXT_LIMITS = {
  title: 120,
  updateBody: 4_000,
  postmortemBody: 20_000,
  componentDescription: 200,
  label: 120,
  incidentPublicText: 200_000,
  summaryUpdateBody: 1_000,
} as const;

export const MAX_INCIDENT_UPDATES = 200;
export const SUMMARY_LATEST_UPDATES = 3;

export const COMPONENT_VISIBILITIES = ['public', 'admin', 'hidden'] as const;
export type ComponentVisibility = (typeof COMPONENT_VISIBILITIES)[number];
export const COMPONENT_MONITORING = ['probed', 'manual', 'vendor'] as const;
export type ComponentMonitoring = (typeof COMPONENT_MONITORING)[number];
export const COMPONENT_SOURCES = ['core', 'contributed'] as const;
export type ComponentSource = (typeof COMPONENT_SOURCES)[number];
export const INCIDENT_SOURCES = ['admin', 'auto_draft', 'break_glass'] as const;
export type IncidentSource = (typeof INCIDENT_SOURCES)[number];
export const INCIDENT_CLASSIFICATIONS = ['standard', 'security'] as const;
export type IncidentClassification = (typeof INCIDENT_CLASSIFICATIONS)[number];
export const PROBES_TRIGGERS = ['scheduled', 'manual'] as const;
export type ProbesTrigger = (typeof PROBES_TRIGGERS)[number];

export interface StatusVendorDoc {
  key: string;
  displayName: string;
  statusPageUrl: string;
  publicNaming: boolean;
}

export interface StatusComponentDoc {
  key: string;
  publicSlug: string;
  source: ComponentSource;
  contributorId?: string;
  name: string;
  description?: string;
  /** Slug of the group this row sits under. */
  group: string;
  order: number;
  visibility: ComponentVisibility;
  monitoring: ComponentMonitoring;
  vendor?: StatusVendorDoc;
  externallyMonitored: boolean;
  probeKeys: string[];
  hysteresis?: { fail: number; recover: number };
  retiredAt?: Date;
  parentKey?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface StatusIncidentUpdateDoc {
  updateId: string;
  at: Date;
  status: IncidentStatus;
  body: string;
  authorId: string;
  impactChange?: { from: OverallImpact; to: OverallImpact };
  componentChanges?: { componentKey: string; from: ComponentImpact | null; to: ComponentImpact | null }[];
  editedAt?: Date;
  editHistory: { at: Date; editorId: string; body: string }[];
}

export interface StatusIncidentDoc {
  publicId: string;
  kind: IncidentKind;
  published: boolean;
  firstPublishedAt?: Date;
  detectedAt?: Date;
  source: IncidentSource;
  classification: IncidentClassification;
  title: string;
  status: IncidentStatus;
  impact: OverallImpact;
  components: { componentKey: string; impact: ComponentImpact }[];
  startedAt: Date;
  resolvedAt?: Date;
  scheduledStartAt?: Date;
  scheduledEndAt?: Date;
  completedEarlyAt?: Date;
  cancelledAt?: Date;
  announcedAt?: Date;
  plannedMessages?: { start?: string; end?: string };
  updates: StatusIncidentUpdateDoc[];
  internalNotes: { at: Date; authorId: string; body: string }[];
  postmortem?: { url?: string; body?: string; publishedAt?: Date };
  postmortemDueAt?: Date;
  detection?: { firstFailureAt: Date; probeKeys: string[]; upstream?: string };
  breakGlass?: { journalKeys: string[]; actorIds: string[]; firstWrittenAt: Date; backdateConfirmedBy?: string };
  retracted?: { at: Date; by: string; reason: string };
  version: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Everything the projection needs to know about one component at publish time. */
export interface StatusComponentRuntime {
  component: StatusComponentDoc;
  /** Raw automatic state after hysteresis and staleness handling. */
  automaticState: DisplayState;
  activePin?: ComponentState | null;
  suppressed?: boolean;
  /** Feed indicator for vendor rows; our own signals never feed it. */
  vendorFeed?: { indicator: VendorIndicator; checkedAt: Date } | null;
}

export interface StatusGroupDef {
  slug: string;
  name: string;
  order: number;
}

export type BarCode = 'o' | 'd' | 'p' | 'm' | 'x' | 'n';

export interface UptimeDayInput {
  day: string;
  barCode: BarCode;
  /** Basis points, null when there is no data. */
  uptimeBp: number | null;
  downtimeMinutes: number;
  incidentIds: string[];
}

export interface UptimeComponentInput {
  componentKey: string;
  /** Fraction in [0, 1]; null when there is no data. 1 only when downtime is exactly 0. */
  uptime: number | null;
  days: UptimeDayInput[];
}
