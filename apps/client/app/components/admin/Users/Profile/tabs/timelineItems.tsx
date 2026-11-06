import React from 'react';
import type { AuditEntry, UserTimelineEntry, UserTimelineType } from '@bike4mind/common';
import { RelativeTime } from '../../../shared';
import { describeAuditEntry } from './auditSentence';
import type { TimelineItem, TimelineTile } from './TimelineList';

export const TIMELINE_TYPE_LABELS: Readonly<Record<UserTimelineType, string>> = {
  signup: 'Signup',
  signin: 'Sign-ins',
  key: 'API keys',
  usage: 'Notebooks',
  spend: 'Spend',
  limit: 'Limits',
  credit: 'Credits',
  payment: 'Payments',
  admin: 'Admin',
  moderation: 'Moderation',
};

const TILES: Readonly<Record<UserTimelineType, TimelineTile>> = {
  signup: { text: 'SU', tone: 'good' },
  signin: { text: 'IN', tone: 'good' },
  key: { text: 'KY', tone: 'neutral' },
  usage: { text: 'NB', tone: 'info' },
  spend: { text: 'AI', tone: 'info' },
  limit: { text: 'LM', tone: 'bad' },
  credit: { text: 'CR', tone: 'warn' },
  payment: { text: 'PY', tone: 'bad' },
  admin: { text: 'AD', tone: 'neutral' },
  moderation: { text: 'MD', tone: 'bad' },
};

// Refused or failed auth events get the bad tone; their summary already says so in words.
const BAD_AUTH_ACTIONS = new Set([
  'auth.step_up_failed',
  'auth.session_reuse_revoked',
  'auth.refresh_replay_capped',
  'auth.refresh_recovery_capped',
  'auth.oauth_refresh_reuse_revoked',
]);

/** The server's `alert` (a refusal, a negative balance, a failed charge) turns any tile red. */
const tileFor = (entry: UserTimelineEntry): TimelineTile => {
  const tile = TILES[entry.type];
  const badAuth = entry.type === 'signin' && BAD_AUTH_ACTIONS.has(entry.audit.action);
  return entry.alert || badAuth ? { ...tile, tone: 'bad' } : tile;
};

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
    flags: entry.flags,
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
    case 'spend':
    case 'payment':
      return { ...base, summary: entry.summary, meta: entry.detail || undefined, onOpen: handlers.onOpenCredits };
    case 'usage':
    case 'signup':
    case 'limit':
    case 'moderation':
      return { ...base, summary: entry.summary, meta: entry.detail };
  }
};
