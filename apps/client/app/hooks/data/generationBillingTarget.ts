import { useSelectedAccount } from '@client/app/components/Credits/AccountSelector';

// Bills the account the switcher shows, read at submit so a later switch is honoured. Read from the switcher's
// own store, not useLLM's organizationId mirror: login clears the mirror to null (personal) while the switcher
// keeps the team, and only a mounted sidenav re-syncs them. With no selection yet the field is omitted so the
// server falls back to the home org rather than billing personal credits by accident.
export function switcherBillingTarget(): { organization_id?: string | null } {
  const { selectedAccount } = useSelectedAccount.getState();
  if (!selectedAccount) return {};
  return { organization_id: selectedAccount.personal ? null : selectedAccount.id };
}
