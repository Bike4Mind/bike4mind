import AdminPage from '@client/app/components/admin/AdminPage';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';

const Admin = () => {
  useDocumentTitle('Admin');

  return <AdminPage enableUserMigration={false} />;
};

export default Admin;
