import { resolveSettingDefinition, type AuditTarget } from '@bike4mind/common';
import { ADMIN_ORGANIZATIONS_TAB_SLUG, ORGS_ORG_ID_PARAM } from '../../organizationsTabSearch';
import { ADMIN_SETTINGS_SEARCH_PARAM, ADMIN_SETTINGS_TAB_SLUG } from '../../adminTabParams';

export function auditTargetHref(target: AuditTarget): string | undefined {
  if (!target.id) return undefined;
  if (target.kind === 'user') return `/admin/users/${encodeURIComponent(target.id)}`;
  if (target.kind === 'organization')
    return `/admin?${new URLSearchParams({ tab: ADMIN_ORGANIZATIONS_TAB_SLUG, [ORGS_ORG_ID_PARAM]: target.id })}`;
  if (target.kind === 'settings' && resolveSettingDefinition(target.id))
    return `/admin?${new URLSearchParams({ tab: ADMIN_SETTINGS_TAB_SLUG, [ADMIN_SETTINGS_SEARCH_PARAM]: target.id })}`;
  return undefined;
}
