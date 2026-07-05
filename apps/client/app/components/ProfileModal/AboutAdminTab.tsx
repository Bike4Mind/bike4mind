import React from 'react';
import { useUser } from '@client/app/contexts/UserContext';
import AdminDataForm from '@client/app/components/ProfileModal/AdminTabContent';

const AdminTabContent = () => {
  const { currentUser } = useUser();

  return <>{currentUser && <AdminDataForm userData={currentUser} />}</>;
};

export default AdminTabContent;
