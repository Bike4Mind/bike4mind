import React from 'react';
import { Alert, Link, Stack, Typography } from '@mui/joy';
import { buildSuspensionNotice } from '@bike4mind/common';
import { WEBSITE_URL, getWebsiteUrl } from '@client/config/general';

type AccountSuspendedNoticeProps = {
  /** The stored category, or an untrusted `?reason=` value; anything unknown reads as the generic category. */
  category: unknown;
  supportEmail?: string | null;
};

/**
 * What a suspended user sees on the sign-in page, whether they arrived from an OAuth redirect, a
 * one-time-code sign-in or a session the app ended (ApiContext). Persistent rather than a toast: it is
 * the user's only explanation and appeal path. The copy is shared with the API body and the email
 * (buildSuspensionNotice), so it never names what flagged the account.
 */
export const AccountSuspendedNotice: React.FC<AccountSuspendedNoticeProps> = ({ category, supportEmail }) => {
  const notice = buildSuspensionNotice(category, { email: supportEmail });
  return (
    <Alert
      color="danger"
      variant="soft"
      role="alert"
      sx={{ width: '100%', maxWidth: '420px', mt: '24px', alignItems: 'flex-start' }}
      data-testid="account-suspended-notice"
    >
      <Stack spacing={1}>
        <Typography level="title-md" color="danger">
          Account suspended
        </Typography>
        <Typography level="body-sm" data-testid="account-suspended-notice-message">
          {notice.message}
        </Typography>
        <Stack direction="row" spacing={2} flexWrap="wrap">
          {WEBSITE_URL && (
            <Link
              href={getWebsiteUrl(notice.policy.slug)}
              target="_blank"
              rel="noopener noreferrer"
              level="body-sm"
              data-testid="account-suspended-notice-policy-link"
            >
              Read the {notice.policy.name}
            </Link>
          )}
          {supportEmail && (
            <Link
              href={`mailto:${supportEmail}?subject=${encodeURIComponent('Suspension appeal')}`}
              level="body-sm"
              data-testid="account-suspended-notice-appeal-link"
            >
              Appeal by email
            </Link>
          )}
        </Stack>
      </Stack>
    </Alert>
  );
};
