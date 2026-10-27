import React from 'react';
import type { AuditEntry, UserTimelineEntry, UserTimelineType } from '@bike4mind/common';
import { RelativeTime } from '../../../shared';
import { describeAuditEntry } from './auditSentence';
import type { TimelineItem, TimelineTile } from './TimelineList';

export const TIMELINE_TYPE_LABELS: Readonly<Record<UserTimelineType, string>> = {
  signin: 'Sign-ins',
  usage: 'Usage',
  credit: 'Credits',
  key: 'API keys',
  admin: 'Admin',
};

const TILES: Readonly<Record<UserTimelineType, TimelineTile>> = {
  usage: { text: 'AI', tone: 'info' },
  credit: { text: 'CR', tone: 'warn' },
  signin: { text: 'IN', tone: 'good' },
  key: { text: 'KY', tone: 'neutral' },
  admin: { text: 'AD', tone: 'neutral' },
};

// Refused or failed auth events get the bad tone; their summary already says so in words.
const BAD_AUTH_ACTIONS = new Set([
  'auth.step_up_failed',
  'auth.session_reuse_revoked',
  'auth.refresh_replay_capped',
  'auth.refresh_recovery_capped',
  'auth.oauth_refresh_reuse_revoked',
]);

const tileFor = (entry: UserTimelineEntry): TimelineTile =>
  entry.type === 'signin' && BAD_AUTH_ACTIONS.has(entry.audit.action) ? { text: 'IN', tone: 'bad' } : TILES[entry.type];

/** Admin entry meta: "Reason: x" then "by <actor>", joined with a middle dot. */
export const adminMeta = (audit: AuditEntry): string =>
  [audit.reason && `Reason: ${audit.reason}`, `by ${audit.actor.name}`].filter(Boolean).join(' \u00b7 ');

export type TimelineHandlers = {
  onOpenAudit: (entry: AuditEntry) => void;
  onOpenCredits?: () => void;
};

export const timelineItem = (entry: UserTimelineEntry, handlers: TimelineHandlers): TimelineItem => {
  const base = {
    id: `${entry.type}-${entry.id}`,
    tile: tileFor(entry),
    aside: <RelativeTime at={entry.at} />,
  };
  switch (entry.type) {
    case 'admin':
      return {
        ...base,
        summary: describeAuditEntry(entry.audit),
        meta: adminMeta(entry.audit),
        onOpen: () => handlers.onOpenAudit(entry.audit),
      };
    case 'signin':
    case 'key':
      return { ...base, summary: entry.summary, meta: entry.detail, onOpen: () => handlers.onOpenAudit(entry.audit) };
    case 'credit':
      return { ...base, summary: entry.summary, meta: entry.detail || undefined, onOpen: handlers.onOpenCredits };
    case 'usage':
      return { ...base, summary: entry.summary, meta: entry.detail };
  }
};
