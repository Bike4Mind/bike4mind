import VerifyEmailChange from '@client/app/components/VerifyEmailChange';
import { useSearch } from '@tanstack/react-router';

const VerifyEmailChangePage = () => {
  const search = useSearch({ strict: false });
  const { token } = search as any;

  return <VerifyEmailChange token={token as string} />;
};

export default VerifyEmailChangePage;
