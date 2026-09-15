import Bike4MindIcon from '@client/app/components/svgs/icons/Bike4MindIcon';
import { useLLM } from '@client/app/contexts/LLMContext';
import { useUser } from '@client/app/contexts/UserContext';
import { useGetUserOrganizations } from '@client/app/hooks/data/organizations';
import { Box, Chip, Option, Radio, Select, Tooltip } from '@mui/joy';
import { useTheme } from '@mui/joy/styles';
import { useMemo, useEffect, useCallback } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { green, greenAlpha } from '@client/app/utils/themes/colors';
import { FIELD_TOOLTIPS } from '@client/app/components/help/fieldTooltips';

type Account = {
  id: string;
  name: string;
  personal: boolean;
  credits: number;
};

// Strip only the trailing " (Personal)" suffix this component appends - anchored so a real
// name that happens to contain "(Personal)" isn't mangled.
const stripPersonalSuffix = (name: string) => name.replace(/ \(Personal\)$/, '');

interface SelectedAccountStore {
  selectedAccount: Account | null;
  setSelectedAccount: (account: Account | null) => void;
}

export const useSelectedAccount = create<SelectedAccountStore>()(
  persist(
    set => ({
      selectedAccount: null,
      setSelectedAccount: account => set({ selectedAccount: account }),
    }),
    {
      name: 'selected-account-storage',
    }
  )
);

/**
 * Account list + selection logic shared by the AccountSelector dropdown (still used in tests
 * and any standalone mounts) and the redesigned sidebar profile menu. Whichever component is
 * mounted runs the sync effects, so the LLM organizationId stays in step with the persisted
 * selected account across reloads.
 */
export const useAccounts = () => {
  const { selectedAccount, setSelectedAccount: setSelectedAccountStore } = useSelectedAccount();
  const { currentUser } = useUser();
  const {
    data: organizations,
    refetch: refetchOrganizations,
    isSuccess: orgsLoaded,
  } = useGetUserOrganizations(currentUser?.id);
  const setLLM = useLLM(s => s.setLLM);

  const setSelectedAccount = useCallback(
    (account: Account | null) => {
      setSelectedAccountStore(account);
      setLLM({ organizationId: account && !account.personal ? account.id : null });
    },
    [setSelectedAccountStore, setLLM]
  );

  const accounts = useMemo(() => {
    const allAccounts: Account[] = [];

    // Add personal account
    if (currentUser) {
      allAccounts.push({
        id: currentUser.id,
        name: `${currentUser.name} (Personal)`,
        personal: true,
        credits: currentUser.currentCredits || 0,
      });
    }

    // Add organization accounts
    if (organizations) {
      organizations.forEach(org => {
        allAccounts.push({
          id: org.id,
          name: org.name,
          personal: false,
          credits: org.currentCredits || 0,
        });
      });
    }

    return allAccounts;
  }, [currentUser, organizations]);

  // Only label accounts (Personal)/(Team) once there's more than one to disambiguate -
  // the "(Personal)" suffix is meaningless to a fresh user with only their own account.
  const showAccountType = accounts.length > 1;

  // On mount, re-sync LLM organizationId from the persisted selectedAccount.
  // useSelectedAccount uses Zustand persist so it survives page reload,
  // but useLLM is not persisted - organizationId would be null after reload,
  // causing the backend to use personal credits even when an org account is selected.
  useEffect(() => {
    const { selectedAccount: persisted } = useSelectedAccount.getState();
    setLLM({ organizationId: persisted && !persisted.personal ? persisted.id : null });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Set personal account as default when no account is selected, or when the previously
  // selected account no longer exists in available accounts.
  useEffect(() => {
    if (accounts.length === 0) return;

    const selectionMissing = !!selectedAccount && !accounts.find(account => account.id === selectedAccount.id);
    // A persisted Team selection is briefly "missing" on hard reload because org accounts
    // load after first paint - resetting then would wipe it every reload. Only treat
    // a missing selection as genuinely gone (e.g. the user left the org) once orgs resolved.
    if (selectionMissing && !orgsLoaded) return;

    const needsDefault = !selectedAccount || selectionMissing;
    if (needsDefault) {
      const personalAccount = accounts.find(account => account.personal);
      if (personalAccount) {
        setSelectedAccount(personalAccount);
      }
    }
  }, [accounts, selectedAccount, setSelectedAccount, orgsLoaded]);

  // Update selected account if it exists in accounts but data has changed
  // (e.g. credits fluctuate, or the user renames their profile). Comparing
  // name too keeps the collapsed dropdown value in sync after a profile
  // rename - otherwise it shows the stale persisted name until credits change.
  useEffect(() => {
    if (selectedAccount) {
      const updatedAccount = accounts.find(account => account.id === selectedAccount.id);
      if (
        updatedAccount &&
        (updatedAccount.credits !== selectedAccount.credits || updatedAccount.name !== selectedAccount.name)
      ) {
        setSelectedAccount(updatedAccount);
      }
    }
  }, [accounts, selectedAccount, setSelectedAccount]);

  return { accounts, selectedAccount, setSelectedAccount, showAccountType, refetchOrganizations };
};

const AccountSelector = () => {
  const theme = useTheme();
  const { accounts, selectedAccount, setSelectedAccount, showAccountType, refetchOrganizations } = useAccounts();

  return (
    <Box className="account-selector-container" sx={{ paddingX: '10px' }}>
      <Select
        className="account-selector"
        onListboxOpenChange={isOpen => {
          if (isOpen) refetchOrganizations();
        }}
        sx={{
          height: '44px',
          fontSize: '14px',
          backgroundColor: theme.palette.credits?.accountSelector.backgroundColor,
        }}
        slotProps={{
          listbox: {
            sx: {
              padding: '8px',
              gap: '8px',
              maxHeight: '300px',
              backgroundColor: theme.palette.credits?.accountSelector.listboxBackground,
            },
          },
        }}
        renderValue={option => {
          if (!option || !selectedAccount) return null;

          const accountName = stripPersonalSuffix(selectedAccount.name);
          return (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}>
              <Tooltip title={accountName} placement="top">
                <Box
                  sx={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    flex: 1,
                    minWidth: 0,
                  }}
                >
                  {accountName}
                </Box>
              </Tooltip>
              {showAccountType && (
                <Box sx={{ flexShrink: 0 }}>{selectedAccount.personal ? '(Personal)' : '(Team)'}</Box>
              )}
            </Box>
          );
        }}
        value={selectedAccount?.id ?? null}
        onChange={(event, value) => {
          const account = accounts.find(account => account.id === value);
          if (!account) return;

          setSelectedAccount(account);
        }}
      >
        {accounts.map(account => {
          const accountName = stripPersonalSuffix(account.name);
          return (
            <Option
              key={account.id}
              value={account.id}
              label={account.name}
              className="account-option"
              sx={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                padding: '16px',
                gap: '20px',
                borderRadius: '4px',
                border: `1px solid ${theme.palette.credits?.accountOption.borderColor}`,
                backgroundColor: theme.palette.credits?.accountOption.backgroundColor,
                '&.Mui-selected': {
                  background: theme.palette.credits?.accountOption.selectedBackground,
                  borderColor: greenAlpha[800][50],
                },
                minWidth: 0,
                width: '100%',
                boxSizing: 'border-box',
              }}
            >
              <Box sx={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}>
                  <Tooltip title={accountName} placement="top">
                    <Box
                      sx={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        flex: 1,
                        minWidth: 0,
                        maxWidth: 140,
                      }}
                    >
                      {accountName}
                    </Box>
                  </Tooltip>
                  {showAccountType && <Box sx={{ flexShrink: 0 }}>{account.personal ? '(Personal)' : '(Team)'}</Box>}
                </Box>
                <Radio
                  className="account-option-radio"
                  checked={selectedAccount?.id === account.id}
                  onChange={() => setSelectedAccount(account)}
                  slotProps={{
                    radio: {
                      sx: {
                        '&.Mui-checked': {
                          color: green[950],
                          borderColor: green[950],
                        },
                      },
                    },
                  }}
                />
              </Box>

              <Tooltip title={FIELD_TOOLTIPS.credits} arrow variant="soft" placement="top" sx={{ maxWidth: 280 }}>
                <Chip
                  className="account-credits-chip"
                  data-testid="account-credits-chip"
                  sx={{
                    height: '24px',
                    backgroundColor: theme.palette.credits?.creditsChip.backgroundColor,
                    border: '1px solid',
                    borderColor: theme.palette.credits?.creditsChip.borderColor,
                    padding: '14px 12px',
                    cursor: 'help',
                  }}
                  startDecorator={<Bike4MindIcon size="14" />}
                >
                  <Box component="span">{account.credits.toLocaleString()}</Box>
                </Chip>
              </Tooltip>
            </Option>
          );
        })}
      </Select>
    </Box>
  );
};

export default AccountSelector;
