import { OrgInviteRole } from '@bike4mind/common';
import { FormControl, FormLabel, Option, Select } from '@mui/joy';
import { FC } from 'react';
import { useTranslation } from 'react-i18next';

interface OrgInviteRoleSelectProps {
  value: OrgInviteRole;
  onChange: (role: OrgInviteRole) => void;
  /** Admin is offered only to callers the create route lets grant it (isOrgOwnerOrPlatformAdmin). */
  canGrantAdmin: boolean;
  /** Offer Viewer only, e.g. a share link a non-owner manager mints (invite-links route gate). */
  viewerOnly?: boolean;
  testId: string;
}

const OrgInviteRoleSelect: FC<OrgInviteRoleSelectProps> = ({
  value,
  onChange,
  canGrantAdmin,
  viewerOnly = false,
  testId,
}) => {
  const { t } = useTranslation();
  return (
    <FormControl size="sm">
      <FormLabel>{t('organizations.modals.members.role_label', 'Role')}</FormLabel>
      <Select data-testid={testId} value={value} onChange={(_event, next) => next && onChange(next)}>
        <Option value="viewer">Viewer</Option>
        {!viewerOnly && <Option value="editor">Editor</Option>}
        {!viewerOnly && canGrantAdmin && <Option value="admin">Admin</Option>}
      </Select>
    </FormControl>
  );
};

export default OrgInviteRoleSelect;
