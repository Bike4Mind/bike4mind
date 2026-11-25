import Alert from '@mui/joy/Alert';
import List from '@mui/joy/List';
import ListItem from '@mui/joy/ListItem';
import Radio from '@mui/joy/Radio';
import RadioGroup from '@mui/joy/RadioGroup';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { BillingAccount } from '@shared/account';
import type { AccountSelectionController } from '../credits/useAccountSelection';

export function accountOptionTestId(account: BillingAccount): string {
  return account.personal ? 'account-switcher-option-personal' : `account-switcher-option-${account.id}`;
}

function formatBalance(credits: number | null): string {
  return credits === null ? '-' : Math.round(credits).toLocaleString();
}

/**
 * Personal or one organization: who pays for every credit-spending call from this app. Mirrors
 * the web's account switcher. A user with no organizations has nothing to pick, so the list stays
 * hidden; the credits header above still names Personal as the payer.
 */
export function AccountSwitcher({ controller }: { controller: AccountSelectionController }) {
  const { selection, pending, error, select } = controller;
  if (!selection?.selected) return null;
  const { accounts, selected, droppedOrganizationId } = selection;
  const choosable = accounts.length > 1;

  return (
    <Stack spacing={0.75} sx={{ px: 1, pb: 1 }} data-testid="account-switcher">
      {droppedOrganizationId && (
        <Alert size="sm" variant="soft" color="warning" data-testid="account-switcher-fallback">
          The organization you picked is no longer available, so Personal pays now.
        </Alert>
      )}
      {choosable && (
        <>
          <Typography level="body-xs" textColor="text.tertiary" id="account-switcher-label">
            Pay with
          </Typography>
          <RadioGroup
            aria-labelledby="account-switcher-label"
            value={selected.id}
            name="billing-account"
            size="sm"
            onChange={event => {
              const account = accounts.find(candidate => candidate.id === event.target.value);
              if (account && account.id !== selected.id) select(account);
            }}
          >
            <List size="sm" sx={{ '--List-gap': '2px', '--ListItem-minHeight': '30px', p: 0 }}>
              {accounts.map(account => (
                <ListItem
                  key={account.id}
                  sx={{
                    borderRadius: 'sm',
                    px: 1,
                    '&:hover': { bgcolor: 'background.level1' },
                    ...(account.id === selected.id && { bgcolor: 'background.level1' }),
                  }}
                >
                  <Radio
                    overlay
                    value={account.id}
                    disabled={pending !== null}
                    label={account.personal ? 'Personal' : account.name}
                    slotProps={{ input: { 'data-testid': accountOptionTestId(account) } }}
                    sx={{ flex: 1, minWidth: 0, '& .MuiRadio-label': { overflow: 'hidden', textOverflow: 'ellipsis' } }}
                  />
                  <Typography
                    level="body-xs"
                    textColor="text.tertiary"
                    sx={{ fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}
                    data-testid={`${accountOptionTestId(account)}-balance`}
                  >
                    {formatBalance(account.credits)}
                  </Typography>
                </ListItem>
              ))}
            </List>
          </RadioGroup>
        </>
      )}
      {(error || selection.error) && (
        <Typography level="body-xs" color="danger" data-testid="account-switcher-error">
          {error ?? selection.error}
        </Typography>
      )}
    </Stack>
  );
}
