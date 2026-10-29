import React from 'react';
import { Button, Dropdown, Link, ListDivider, ListItemContent, Menu, MenuButton, MenuItem, Typography } from '@mui/joy';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import type { AdminSubscriptionDetail } from '@client/app/utils/adminSubscriptionDetail';
import { EntityHeader, StatusChip } from '../../shared';
import { showsCompedChip, subscriptionStatusDisplay } from './subscriptionStatus';
import {
  ownerDisplayName,
  ownerLink,
  subscriptionActionAvailability,
  type OwnerLink,
  type SubscriptionAction,
} from './subscriptionDetailModel';

type SubscriptionDetailHeaderProps = {
  detail: AdminSubscriptionDetail;
  onAction: (action: SubscriptionAction) => void;
  onOpenOwner: (link: OwnerLink) => void;
};

/** A menu entry whose disabled state explains itself in place (DESIGN_GUIDE.md section 4). */
const ExplainedMenuItem: React.FC<{
  label: string;
  disabledReason: string | null;
  danger?: boolean;
  onClick: () => void;
  'data-testid': string;
}> = ({ label, disabledReason, danger, onClick, 'data-testid': testId }) => (
  <MenuItem
    color={danger ? 'danger' : 'neutral'}
    disabled={disabledReason !== null}
    onClick={onClick}
    data-testid={testId}
    sx={{ alignItems: 'flex-start' }}
  >
    <ListItemContent>
      {label}
      {disabledReason && (
        <Typography
          level="body-xs"
          sx={{ color: 'admin.inkMuted', whiteSpace: 'normal', maxWidth: 260 }}
          data-testid={`${testId}-reason`}
        >
          {disabledReason}
        </Typography>
      )}
    </ListItemContent>
  </MenuItem>
);

/** Identity, status and the actions for this subscription: comp controls up front, the rest under More. */
export const SubscriptionDetailHeader: React.FC<SubscriptionDetailHeaderProps> = ({
  detail,
  onAction,
  onOpenOwner,
}) => {
  const { subscription } = detail;
  const name = ownerDisplayName(subscription);
  const link = ownerLink(subscription);
  const status = subscriptionStatusDisplay(subscription);
  const available = subscriptionActionAvailability(detail);

  return (
    <EntityHeader
      title={name}
      id={subscription.id}
      status={
        <>
          <StatusChip tone={status.tone} label={status.label} dot data-testid="subscription-detail-status-chip" />
          {showsCompedChip(subscription) && (
            <StatusChip tone="info" label="Comped" data-testid="subscription-detail-comped-chip" />
          )}
        </>
      }
      times={[{ prefix: 'Created', at: subscription.createdAt, 'data-testid': 'subscription-detail-created' }]}
      meta={
        link && (
          <Link
            component="button"
            type="button"
            level="body-sm"
            onClick={() => onOpenOwner(link)}
            data-testid="subscription-detail-owner-link"
          >
            {link.kind === 'user' ? 'Open user profile' : 'Open organization'}
          </Link>
        )
      }
      actions={
        <>
          {available.compActions && (
            <>
              <Button
                variant="outlined"
                color="neutral"
                onClick={() => onAction('extend')}
                data-testid="subscription-detail-extend-btn"
              >
                Extend comp
              </Button>
              <Button
                variant="outlined"
                color="danger"
                onClick={() => onAction('end')}
                data-testid="subscription-detail-end-btn"
              >
                End comp
              </Button>
            </>
          )}
          <Dropdown>
            <MenuButton
              slots={{ root: Button }}
              slotProps={{ root: { variant: 'outlined', color: 'neutral', 'aria-label': 'More actions' } }}
              sx={{ px: 1 }}
              data-testid="subscription-detail-more-btn"
            >
              <MoreHorizIcon />
            </MenuButton>
            <Menu placement="bottom-end" sx={{ minWidth: 240 }} data-testid="subscription-detail-more-menu">
              {available.editCredits.visible && (
                <ExplainedMenuItem
                  label="Edit credits per cycle"
                  disabledReason={available.editCredits.disabledReason}
                  onClick={() => onAction('credits')}
                  data-testid="subscription-detail-menu-credits-item"
                />
              )}
              {available.editCredits.visible && <ListDivider />}
              <ExplainedMenuItem
                label="Remove subscription"
                danger
                disabledReason={available.remove.disabledReason}
                onClick={() => onAction('remove')}
                data-testid="subscription-detail-menu-remove-item"
              />
            </Menu>
          </Dropdown>
        </>
      }
    />
  );
};
