import { EditedFieldsState } from '@client/app/components/admin/Users/Views/FullUsersView';
import { allKnownEntitlementKeys, grantTagForEntitlement } from '@client/lib/entitlements/registry';
import { DEVELOPER_USER_TAGS, IUserDocument, hasDeveloperUserTag } from '@bike4mind/common';
import { Button, FormLabel, Input, Radio, RadioGroup, Stack, Tooltip, IconButton } from '@mui/joy';
import React, { useEffect, useState } from 'react';

/**
 * Comp tags that grant a product entitlement (e.g. `opti`, `opti-compute`) -
 * these have their own dedicated grant/revoke control in the Product Access
 * section, so the freeform "Custom Tags" list below hides them to avoid two
 * controls editing the same tag.
 */
const PRODUCT_GRANT_TAGS = allKnownEntitlementKeys()
  .map(grantTagForEntitlement)
  .filter((tag): tag is string => Boolean(tag));

const isManagedTag = (tag: string): boolean => {
  const normalized = tag.toLowerCase();
  return (
    (DEVELOPER_USER_TAGS as readonly string[]).some(t => t.toLowerCase() === normalized) ||
    PRODUCT_GRANT_TAGS.some(t => t.toLowerCase() === normalized)
  );
};

interface UserPermissionsProps {
  user: IUserDocument;
  handleUserLevelButtonChange: (userId: string) => void;
  editedFields: EditedFieldsState;
  onFieldChange: (fieldName: keyof IUserDocument, value: unknown) => void;
}

/**
 * The canonical auth ROLE, derived-on-read from `isAdmin` + the developer
 * tag - NOT from `user.level` (that stays an Overwatch analytics
 * classification, unrelated to authorization; see the "Demo User" button
 * below). Precedence for pre-existing multi-valued users: Super Admin >
 * Developer > Customer.
 */
type Role = 'super-admin' | 'developer' | 'customer';

const getRole = (isAdmin: boolean, tags: readonly string[]): Role => {
  if (isAdmin) return 'super-admin';
  if (hasDeveloperUserTag(tags)) return 'developer';
  return 'customer';
};

const ROLE_OPTIONS: { value: Role; label: string }[] = [
  { value: 'customer', label: 'Customer' },
  { value: 'developer', label: 'Developer' },
  { value: 'super-admin', label: 'Super Admin' },
];

const withoutDeveloperTags = (tags: readonly string[]): string[] =>
  tags.filter(tag => !(DEVELOPER_USER_TAGS as readonly string[]).includes(tag));

const userLevelColor = (user: IUserDocument) => {
  switch (user.level) {
    case 'DemoUser':
      return 'neutral';
    case 'PaidUser':
      return 'primary';
    case 'VIPUser':
      return 'success';
    case 'ManagerUser':
      return 'warning';
    case 'AdminUser':
      return 'danger';
    default:
      return 'neutral';
  }
};

const userLevelDisplay = (user: IUserDocument) => {
  switch (user.level) {
    case 'DemoUser':
      return 'Demo User';
    case 'PaidUser':
      return 'Paid User';
    case 'VIPUser':
      return 'VIP User';
    case 'ManagerUser':
      return 'Manager User';
    case 'AdminUser':
      return 'Admin User';
    default:
      return user.level;
  }
};

const UserPermissions: React.FC<UserPermissionsProps> = React.memo(
  ({ user, editedFields, onFieldChange, handleUserLevelButtonChange }) => {
    const [localTags, setLocalTags] = useState(user.tags || []);
    const [customTagsInput, setCustomTagsInput] = useState('');

    const role = getRole(user.isAdmin, localTags);
    const customTags = localTags.filter(tag => !isManagedTag(tag));

    useEffect(() => {
      setLocalTags(user.tags || []);
      setCustomTagsInput('');
    }, [user]);

    const handleRoleChange = (newRole: Role) => {
      const strippedTags = withoutDeveloperTags(localTags);
      const newIsAdmin = newRole === 'super-admin';
      const newTags = newRole === 'developer' ? [...strippedTags, 'Developer'] : strippedTags;

      onFieldChange('isAdmin', newIsAdmin);
      setLocalTags(newTags);
      onFieldChange('tags', newTags);
    };

    const handleCustomTagsInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      setCustomTagsInput(e.target.value);
    };

    const handleAddCustomTags = () => {
      if (customTagsInput.trim()) {
        const newCustomTags = customTagsInput
          .split(',')
          .map(tag => tag.trim())
          .filter(tag => tag.length > 0 && !localTags.includes(tag));
        const updatedTags = [...localTags, ...newCustomTags];
        setLocalTags(updatedTags);
        onFieldChange('tags', updatedTags);
        setCustomTagsInput('');
      }
    };

    const handleRemoveTag = (tagToRemove: string) => {
      const updatedTags = localTags.filter(tag => tag !== tagToRemove);
      setLocalTags(updatedTags);
      onFieldChange('tags', updatedTags);
    };

    return (
      <Stack direction="column" spacing={2}>
        <Tooltip title="Tap to Change User Level">
          <Button size="sm" color={userLevelColor(user)} onClick={() => handleUserLevelButtonChange(user.id)}>
            {userLevelDisplay(user)}
          </Button>
        </Tooltip>
        <Stack spacing={0.5}>
          <FormLabel>Role</FormLabel>
          <RadioGroup
            value={role}
            onChange={e => handleRoleChange(e.target.value as Role)}
            sx={{ color: editedFields?.isAdmin || editedFields?.tags ? 'primary.plainColor' : undefined }}
          >
            {ROLE_OPTIONS.map(option => (
              <Radio
                key={option.value}
                value={option.value}
                label={option.label}
                data-testid={`role-radio-${option.value}`}
              />
            ))}
          </RadioGroup>
        </Stack>
        <Stack direction="column" spacing={1}>
          <Stack direction="row" spacing={2}>
            <span>Custom Tags:</span>
          </Stack>
          <Stack direction="row" spacing={2}>
            <Input
              size="sm"
              sx={{
                borderColor: editedFields?.tags ? 'primary.500' : 'default',
                flex: 1,
              }}
              type="text"
              placeholder="Input a custom tag"
              value={customTagsInput}
              onChange={handleCustomTagsInputChange}
            />
            <Button size="sm" color="primary" disabled={!customTagsInput.trim()} onClick={handleAddCustomTags}>
              Add
            </Button>
          </Stack>
          {/* Display only custom tags (not the Role/Product-Access managed ones) with remove option */}
          {customTags.length > 0 && (
            <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
              {customTags.map(tag => (
                <Stack
                  key={tag}
                  direction="row"
                  spacing={0.5}
                  sx={{
                    backgroundColor: '#f0f0f0',
                    padding: '2px 6px',
                    borderRadius: '4px',
                    fontSize: '0.8em',
                    color: editedFields?.tags ? '#1976d2' : '#666',
                    alignItems: 'center',
                  }}
                >
                  <span>{tag}</span>
                  <IconButton
                    size="sm"
                    color="neutral"
                    sx={{
                      minHeight: '16px',
                      minWidth: '16px',
                      padding: '0',
                      fontSize: '10px',
                    }}
                    onClick={() => handleRemoveTag(tag)}
                    data-testid={`remove-tag-${tag}`}
                  >
                    ×
                  </IconButton>
                </Stack>
              ))}
            </Stack>
          )}
        </Stack>
      </Stack>
    );
  }
);

UserPermissions.displayName = 'UserPermissions';

export default UserPermissions;
