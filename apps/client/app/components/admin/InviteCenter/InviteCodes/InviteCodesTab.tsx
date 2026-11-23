import { useEffect } from 'react';
import InviteCodesSection from './InviteCodesSection';
import { useRegistrationInvitesStore } from './store';

interface InviteCodesTabProps {
  quickAction: string | null;
}

const InviteCodesTab = ({ quickAction }: InviteCodesTabProps) => {
  const setOpenCreate = useRegistrationInvitesStore(s => s.setOpenCreate);

  useEffect(() => {
    if (quickAction === 'generate-codes') {
      setOpenCreate(true);
    }
  }, [quickAction, setOpenCreate]);

  return <InviteCodesSection />;
};

export default InviteCodesTab;
