import React from 'react';
import { Chip, Tooltip } from '@mui/joy';
import { CheckCircle, RadioButtonUnchecked } from '@mui/icons-material';
import { IUserDocument } from '@bike4mind/common';

interface MFAStatusBadgeProps {
  user: IUserDocument;
  size?: 'sm' | 'md' | 'lg';
}

const MFAStatusBadge: React.FC<MFAStatusBadgeProps> = ({ user, size = 'sm' }) => {
  const hasMFA = user.mfa && user.mfa.totpEnabled;

  if (hasMFA) {
    return (
      <Tooltip title="Multi-Factor Authentication enabled">
        <Chip size={size} color="success" variant="soft" startDecorator={<CheckCircle />}>
          MFA
        </Chip>
      </Tooltip>
    );
  }

  return (
    <Tooltip title="Multi-Factor Authentication disabled">
      <Chip size={size} color="neutral" variant="outlined" startDecorator={<RadioButtonUnchecked />}>
        MFA
      </Chip>
    </Tooltip>
  );
};

export default MFAStatusBadge;
