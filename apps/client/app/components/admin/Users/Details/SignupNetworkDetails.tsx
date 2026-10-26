import type { ISignupMeta } from '@bike4mind/common';
import { Chip, Stack, Typography } from '@mui/joy';
import React from 'react';

interface SignupNetworkDetailsProps {
  signupMeta: ISignupMeta;
}

const Row: React.FC<{ label: string; value: React.ReactNode; testId: string }> = ({ label, value, testId }) => (
  <Stack direction="row" spacing={2} display="flex" justifyContent="space-between">
    <Typography level="body-xs">{label}</Typography>
    <Typography level="body-xs" data-testid={testId}>
      {value}
    </Typography>
  </Stack>
);

function formatNetwork({ asn, asnOrg }: ISignupMeta): string {
  if (asn === null) return 'Unknown';
  return asnOrg ? `AS${asn} (${asnOrg})` : `AS${asn}`;
}

/** The network the account signed up from (IUser.signupMeta), for spotting abuse cohorts. */
const SignupNetworkDetails: React.FC<SignupNetworkDetailsProps> = ({ signupMeta }) => (
  <>
    <Row label="Signup IP:" value={signupMeta.ip ?? 'Unknown'} testId="signup-network-ip" />
    <Row
      label="Signup network:"
      testId="signup-network-asn"
      value={
        <>
          {formatNetwork(signupMeta)}
          {signupMeta.isDatacenter && (
            <Chip
              size="sm"
              color="warning"
              variant="soft"
              sx={{ ml: 0.5 }}
              data-testid="signup-network-datacenter-chip"
            >
              Datacenter
            </Chip>
          )}
        </>
      }
    />
    <Row label="Signup country:" value={signupMeta.country ?? 'Unknown'} testId="signup-network-country" />
  </>
);

export default SignupNetworkDetails;
