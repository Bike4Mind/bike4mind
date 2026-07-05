import { useSelectedAccount } from '@client/app/components/Credits/AccountSelector';
import { useUser } from '@client/app/contexts/UserContext';

export function useEffectiveCredits(): number {
  const { selectedAccount } = useSelectedAccount();
  const { currentUser } = useUser();

  if (selectedAccount && !selectedAccount.personal) {
    return selectedAccount.credits;
  }
  return currentUser?.currentCredits || 0;
}
