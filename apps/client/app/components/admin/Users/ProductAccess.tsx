import React from 'react';
import { Alert, Button, Chip, CircularProgress, Stack, Tooltip, Typography } from '@mui/joy';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import { IUserDocument } from '@bike4mind/common';
import { EntitlementSourceType, useGetUserProductAccess } from '@client/app/hooks/data/entitlements';

interface ProductAccessProps {
  /** The live-edited user (FullUsersView's formState) - tag grants are staged into it. */
  user: IUserDocument;
  onFieldChange: (fieldName: keyof IUserDocument, value: unknown) => void;
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
 * revoke the tag-based grant.
 *
 * Single source of truth for `tags`: grant/revoke stages into the shared
 * `formState.tags` via `onFieldChange` (identical to the Custom Tags control),
 * committed by the card's one "Update" button. Deriving the tag state from the
 * live `user` (formState) prop - NOT a separate immediate mutation - avoids the
 * split-brain where two independent writers to `tags` clobber each other or a
 * pending Role edit. The read-only source chips (domain / subscription /
 * admin- or developer-bypass) come from the server resolver, which reflects
 * SAVED state - those axes are not editable here (domain grant is env/DB config;
 * a subscription is managed in the Subscription section; bypass follows Role).
 */
const ProductAccess: React.FC<ProductAccessProps> = ({ user, onFieldChange }) => {
  const { data, isLoading, error } = useGetUserProductAccess(user.id);
  const currentTags = user.tags ?? [];

  const handleToggleGrant = (grantTag: string, currentlyGranted: boolean) => {
    const nextTags = currentlyGranted
      ? currentTags.filter(tag => tag.toLowerCase() !== grantTag.toLowerCase())
      : // Dedup case-insensitively so a re-grant (or a differently-cased existing tag) can't
        // write a duplicate into the user document.
        currentTags.some(tag => tag.toLowerCase() === grantTag.toLowerCase())
        ? currentTags
        : [...currentTags, grantTag];
    onFieldChange('tags', nextTags);
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
        // Non-tag sources are server-authoritative (not editable here). The tag axis is
        // derived from the LIVE formState so the button + chip reflect a staged, unsaved
        // grant immediately - the server resolver only refreshes after Save.
        const otherSources = row.sources.filter(source => source.type !== 'tag');
        const liveTagGranted = row.grantTag
          ? currentTags.some(tag => tag.toLowerCase() === row.grantTag!.toLowerCase())
          : false;
        const held = liveTagGranted || otherSources.length > 0;
        const displaySources = liveTagGranted
          ? [...otherSources, { type: 'tag' as const, detail: row.grantTag! }]
          : otherSources;

        return (
          <Stack key={row.key} spacing={0.5} sx={{ borderBottom: '1px solid', borderColor: 'divider', pb: 1 }}>
            <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
              <Typography level="body-sm" fontWeight="bold">
                {row.key}
              </Typography>
              <Chip size="sm" variant="soft" color={held ? 'success' : 'neutral'}>
                {held ? 'Held' : 'None'}
              </Chip>
            </Stack>

            {displaySources.length > 0 && (
              <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
                {displaySources.map((source, i) => (
                  <Tooltip key={`${source.type}-${i}`} title={source.detail}>
                    <Chip size="sm" variant="outlined" color="neutral">
                      {SOURCE_LABEL[source.type] ?? source.type}
                    </Chip>
                  </Tooltip>
                ))}
              </Stack>
            )}

            {liveTagGranted && otherSources.length > 0 && (
              <Alert size="sm" color="warning" variant="soft" startDecorator={<InfoOutlinedIcon />}>
                Also granted via {otherSources.map(source => SOURCE_LABEL[source.type] ?? source.type).join(', ')} -
                revoking the tag alone will not remove access.
              </Alert>
            )}

            {row.grantTag ? (
              <Button
                size="sm"
                variant="outlined"
                color={liveTagGranted ? 'danger' : 'primary'}
                onClick={() => handleToggleGrant(row.grantTag!, liveTagGranted)}
                data-testid={`product-access-toggle-${row.key}`}
                sx={{ alignSelf: 'flex-start' }}
              >
                {liveTagGranted ? `Revoke (${row.grantTag})` : `Grant (${row.grantTag})`}
              </Button>
            ) : (
              !held && (
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
