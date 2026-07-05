import { EditedFieldsState } from '@client/app/components/admin/Users/Views/FullUsersView';
import { IUserDocument, PREDEFINED_USER_TAGS } from '@bike4mind/common';
import { Button, Checkbox, Input, Stack, Tooltip, IconButton } from '@mui/joy';
import React, { useEffect, useState } from 'react';

interface UserPermissionsProps {
  user: IUserDocument;
  handleUserLevelButtonChange: (userId: string) => void;
  editedFields: EditedFieldsState;
  onFieldChange: (fieldName: keyof IUserDocument, value: unknown) => void;
}

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

    const predefinedTags = [...PREDEFINED_USER_TAGS];

    useEffect(() => {
      setLocalTags(user.tags || []);
      setCustomTagsInput('');
    }, [user]);

    const handleAdminChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const newIsAdmin = e.target.checked;
      onFieldChange('isAdmin', newIsAdmin);
    };

    const handleTagChange = (tag: string) => (e: React.ChangeEvent<HTMLInputElement>) => {
      const newTags = e.target.checked ? [...localTags, tag] : localTags.filter(t => t !== tag);
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
        <Checkbox
          size="lg"
          variant="outlined"
          color={editedFields?.isAdmin ? 'primary' : 'neutral'}
          checked={user.isAdmin}
          onChange={handleAdminChange}
          label="Super Admin"
        />
        {predefinedTags.map(tag => (
          <Checkbox
            key={tag}
            size="lg"
            variant="outlined"
            color={editedFields?.tags ? 'primary' : 'neutral'}
            checked={localTags.includes(tag)}
            onChange={handleTagChange(tag)}
            label={tag}
          />
        ))}
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
          {/* Display only custom tags (non-predefined) with remove option */}
          {localTags.filter(tag => !(predefinedTags as readonly string[]).includes(tag)).length > 0 && (
            <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
              {localTags
                .filter(tag => !(predefinedTags as readonly string[]).includes(tag))
                .map(tag => (
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
