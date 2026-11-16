import React from 'react';
import { Box, Button, Stack, Typography } from '@mui/joy';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import type { ModelInfo } from '@bike4mind/common';
import { visuallyHidden } from '@client/app/utils/a11yStyles';

type LockedModelsSectionProps = {
  models: ModelInfo[];
  /** Omitted when there is no in-app upgrade flow (billing off): the rows still explain why the models are locked. */
  onUpgrade?: () => void;
};

type LockGroup = {
  reason: 'requires_paid_plan' | 'org_policy';
  heading: string;
  rowTitle: string;
  srReason: string;
};

const PAID_GROUP: LockGroup = {
  reason: 'requires_paid_plan',
  heading: 'Available on paid plans',
  rowTitle: 'Upgrade to a paid plan to use this model',
  srReason: '(requires a paid plan)',
};

const ORG_GROUP: LockGroup = {
  reason: 'org_policy',
  heading: 'Not allowed by your organization',
  rowTitle: 'Your organization does not allow this model',
  srReason: '(not allowed by your organization)',
};

const LockedGroup = ({
  group,
  models,
  onUpgrade,
}: {
  group: LockGroup;
  models: ModelInfo[];
  onUpgrade?: () => void;
}) => {
  const testIdPrefix = group.reason === 'org_policy' ? 'org-locked' : 'locked';
  return (
    <Box
      data-testid={`${testIdPrefix}-models-section`}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        paddingInline: '8px',
        paddingBlock: '12px',
        borderTop: '1px solid',
        borderColor: 'divider',
      }}
    >
      <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
          <LockOutlinedIcon sx={{ fontSize: '18px', color: 'text.tertiary' }} />
          <Typography level="h4" sx={{ color: 'text.primary', fontSize: '16px', fontWeight: 500 }}>
            {group.heading}
          </Typography>
        </Box>
        {onUpgrade && (
          <Button size="sm" variant="solid" color="primary" onClick={onUpgrade} data-testid="locked-models-upgrade-btn">
            Upgrade
          </Button>
        )}
      </Stack>
      <Box component="ul" sx={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column' }}>
        {models.map(model => (
          <Box
            component="li"
            key={model.id}
            data-testid={`${testIdPrefix}-model-row-${model.id}`}
            aria-disabled="true"
            title={group.rowTitle}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              paddingBlock: '6px',
              paddingInline: '4px',
              cursor: 'not-allowed',
              opacity: 0.6,
            }}
          >
            <LockOutlinedIcon sx={{ fontSize: '16px', color: 'text.tertiary' }} />
            <Typography level="body-sm" sx={{ color: 'text.secondary' }} noWrap>
              {model.name}
            </Typography>
            <Box component="span" sx={visuallyHidden}>
              {group.srReason}
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  );
};

/**
 * Models the caller can see but not pick (see ModelInfo.access), grouped by why. Rows are deliberately inert so
 * nothing here can set the session model. Only the paid-plan group offers an upgrade: no plan lifts an org lock.
 */
const LockedModelsSection = ({ models, onUpgrade }: LockedModelsSectionProps) => {
  const orgLocked = models.filter(model => model.access?.reason === 'org_policy');
  const paidLocked = models.filter(model => model.access?.reason !== 'org_policy');
  return (
    <>
      {paidLocked.length > 0 && <LockedGroup group={PAID_GROUP} models={paidLocked} onUpgrade={onUpgrade} />}
      {orgLocked.length > 0 && <LockedGroup group={ORG_GROUP} models={orgLocked} />}
    </>
  );
};

export default LockedModelsSection;
