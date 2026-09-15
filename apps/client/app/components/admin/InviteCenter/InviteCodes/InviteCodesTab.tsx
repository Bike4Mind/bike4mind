import { useEffect } from 'react';
import RegistrationInvitesTab from '../../RegistrationInvites';
import { useRegistrationInvitesStore } from '../../RegistrationInvites/store';

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

  return <RegistrationInvitesTab />;
};

export default InviteCodesTab;
