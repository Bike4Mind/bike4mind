import React from 'react';
import { Alert, Button, Chip, CircularProgress, Stack, Tooltip, Typography } from '@mui/joy';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import { IUserDocument } from '@bike4mind/common';
import { useQueryClient } from '@tanstack/react-query';
import { EntitlementSourceType, useGetUserProductAccess } from '@client/app/hooks/data/entitlements';
import { useUpdateUser } from '@client/app/hooks/data/user';

interface ProductAccessProps {
  user: IUserDocument;
}

const SOURCE_LABEL: Record<EntitlementSourceType, string> = {
  tag: 'Tag',
  domain: 'Email domain',
  subscription: 'Subscription',
  'admin-bypass': 'Super Admin',
  'developer-bypass': 'Developer tag',
};

/**
 * Per-user "why does this person have (or lack) product access" panel - the
 * fix for phantom-access visibility (admin-roles-product-access-redesign
 * M2+M4). Shows every known product entitlement with EVERY contributing
 * source (tag / domain / subscription / bypass), and lets an admin grant or
 * revoke the tag-based grant directly. Domain and subscription sources are
 * read-only here by design (M4) - a domain grant is env/DB config, and a
 * subscription is managed in the Subscription section above.
 *
 * Deliberately its own immediate-effect mutation (not the batched
 * Roles/Custom-Tags edit-then-Save flow in UserPermissions): revoking access
 * is a distinct, consequential action that should confirm on its own, not
 * ride along with an unrelated pending edit.
 */
const ProductAccess: React.FC<ProductAccessProps> = ({ user }) => {
  const { data, isLoading, error } = useGetUserProductAccess(user.id);
  const updateUser = useUpdateUser();
  const queryClient = useQueryClient();

  const handleToggleGrant = (grantTag: string, currentlyGranted: boolean) => {
    const tags = user.tags ?? [];
    const nextTags = currentlyGranted
      ? tags.filter(tag => tag.toLowerCase() !== grantTag.toLowerCase())
      : [...tags, grantTag];
    updateUser.mutate(
      { id: user.id, data: { tags: nextTags } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ['admin', 'user-entitlements', user.id] });
        },
      }
    );
  };

  if (isLoading) {
    return <CircularProgress size="sm" data-testid="product-access-loading" />;
  }

  if (error) {
    return (
      <Typography level="body-sm" color="danger">
        Failed to load product access
      </Typography>
    );
  }

  if (!data) return null;

  return (
    <Stack spacing={1.5} data-testid="product-access-panel">
      {data.entitlements.map(row => {
        const tagSources = row.sources.filter(source => source.type === 'tag');
        const otherSources = row.sources.filter(source => source.type !== 'tag');
        const hasTagGrant = row.grantTag
          ? tagSources.some(source => source.detail.toLowerCase() === row.grantTag!.toLowerCase())
          : false;

        return (
          <Stack key={row.key} spacing={0.5} sx={{ borderBottom: '1px solid', borderColor: 'divider', pb: 1 }}>
            <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
              <Typography level="body-sm" fontWeight="bold">
                {row.key}
              </Typography>
              <Chip size="sm" variant="soft" color={row.held ? 'success' : 'neutral'}>
                {row.held ? 'Held' : 'None'}
              </Chip>
            </Stack>

            {row.sources.length > 0 && (
              <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
                {row.sources.map((source, i) => (
                  <Tooltip key={`${source.type}-${i}`} title={source.detail}>
                    <Chip size="sm" variant="outlined" color="neutral">
                      {SOURCE_LABEL[source.type] ?? source.type}
                    </Chip>
                  </Tooltip>
                ))}
              </Stack>
            )}

            {hasTagGrant && otherSources.length > 0 && (
              <Alert size="sm" color="warning" variant="soft" startDecorator={<InfoOutlinedIcon />}>
                Also granted via {otherSources.map(source => SOURCE_LABEL[source.type] ?? source.type).join(', ')} -
                revoking the tag alone will not remove access.
              </Alert>
            )}

            {row.grantTag ? (
              <Button
                size="sm"
                variant="outlined"
                color={hasTagGrant ? 'danger' : 'primary'}
                loading={updateUser.isPending}
                onClick={() => handleToggleGrant(row.grantTag!, hasTagGrant)}
                data-testid={`product-access-toggle-${row.key}`}
                sx={{ alignSelf: 'flex-start' }}
              >
                {hasTagGrant ? `Revoke (${row.grantTag})` : `Grant (${row.grantTag})`}
              </Button>
            ) : (
              !row.held && (
                <Typography level="body-xs" color="neutral">
                  No tag-based grant for this product - see Subscription section.
                </Typography>
              )
            )}
          </Stack>
        );
      })}
    </Stack>
  );
};

export default ProductAccess;
