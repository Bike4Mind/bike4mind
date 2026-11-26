import { findUnfilledPlaceholders } from './textPolicy';
import type { IncidentKind, IncidentStatus } from './isActive';
import type { IncidentClassification } from './types';

export const TEMPLATE_PLACEHOLDERS = ['component', 'scope', 'workaround', 'nextUpdate'] as const;
export type TemplatePlaceholder = (typeof TEMPLATE_PLACEHOLDERS)[number];

export const TEMPLATE_SCOPE_OPTIONS = ['some users', 'all users', 'users of a feature'] as const;

export const TEMPLATE_IDS = [
  'investigating',
  'identified',
  'monitoring',
  'resolved',
  'degraded_performance',
  'maintenance_scheduled',
  'maintenance_starting',
  'maintenance_complete',
  'postmortem_published',
  'security_investigating',
  'security_resolved',
] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

export interface StatusTemplate {
  id: TemplateId;
  label: string;
  kind: IncidentKind;
  status: IncidentStatus;
  classification: IncidentClassification;
  body: string;
}

export const STATUS_TEMPLATES: Record<TemplateId, StatusTemplate> = {
  investigating: {
    id: 'investigating',
    label: 'Investigating',
    kind: 'incident',
    status: 'investigating',
    classification: 'standard',
    body: 'We are investigating an issue affecting {component}. {scope} may be affected. {workaround} Next update: {nextUpdate}.',
  },
  identified: {
    id: 'identified',
    label: 'Identified',
    kind: 'incident',
    status: 'identified',
    classification: 'standard',
    body: 'We have identified the cause of the issue affecting {component} and are working on a fix. {scope} may still be affected. {workaround} Next update: {nextUpdate}.',
  },
  monitoring: {
    id: 'monitoring',
    label: 'Monitoring',
    kind: 'incident',
    status: 'monitoring',
    classification: 'standard',
    body: 'A fix has been applied for {component} and we are monitoring the result. Next update: {nextUpdate}.',
  },
  resolved: {
    id: 'resolved',
    label: 'Resolved',
    kind: 'incident',
    status: 'resolved',
    classification: 'standard',
    body: 'The issue affecting {component} has been resolved. Thank you for your patience.',
  },
  degraded_performance: {
    id: 'degraded_performance',
    label: 'Degraded performance',
    kind: 'incident',
    status: 'investigating',
    classification: 'standard',
    body: '{component} is running slower than usual for {scope}. {workaround} Next update: {nextUpdate}.',
  },
  maintenance_scheduled: {
    id: 'maintenance_scheduled',
    label: 'Maintenance scheduled',
    kind: 'maintenance',
    status: 'scheduled',
    classification: 'standard',
    body: 'Scheduled maintenance will affect {component}. {scope} may see interruptions during the window. {workaround}',
  },
  maintenance_starting: {
    id: 'maintenance_starting',
    label: 'Maintenance starting',
    kind: 'maintenance',
    status: 'scheduled',
    classification: 'standard',
    body: 'Scheduled maintenance on {component} is starting now. {scope} may see interruptions. {workaround}',
  },
  maintenance_complete: {
    id: 'maintenance_complete',
    label: 'Maintenance complete',
    kind: 'maintenance',
    status: 'completed',
    classification: 'standard',
    body: 'Scheduled maintenance on {component} is complete and everything is operating normally.',
  },
  postmortem_published: {
    id: 'postmortem_published',
    label: 'Postmortem published',
    kind: 'incident',
    status: 'resolved',
    classification: 'standard',
    body: 'A postmortem for the issue affecting {component} has been published.',
  },
  security_investigating: {
    id: 'security_investigating',
    label: 'Security: investigating',
    kind: 'incident',
    status: 'investigating',
    classification: 'security',
    body: 'We are responding to a security event affecting {component}. {scope} may notice changes. {workaround} Next update: {nextUpdate}.',
  },
  security_resolved: {
    id: 'security_resolved',
    label: 'Security: resolved',
    kind: 'incident',
    status: 'resolved',
    classification: 'security',
    body: 'The security event affecting {component} has been addressed and we have made changes to protect {scope}. {workaround}',
  },
};

export interface RenderedTemplate {
  text: string;
  /** Placeholders still present; the text policy treats these as hard errors. */
  unfilled: string[];
}

/** Single pass, so a value that looks like a placeholder is never expanded again. */
export function renderTemplate(id: TemplateId, values: Partial<Record<TemplatePlaceholder, string>>): RenderedTemplate {
  const body = STATUS_TEMPLATES[id].body;
  const text = body
    .replace(/\{(component|scope|workaround|nextUpdate)\}/g, (match, name: TemplatePlaceholder) => {
      const value = values[name]?.trim();
      return value ? value : match;
    })
    .replace(/ {2,}/g, ' ')
    .trim();
  return { text, unfilled: findUnfilledPlaceholders(text) };
}
