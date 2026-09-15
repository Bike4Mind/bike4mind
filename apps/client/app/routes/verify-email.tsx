import VerifyEmail from '@client/app/components/VerifyEmail';
import { useSearch } from '@tanstack/react-router';

const VerifyEmailPage = () => {
  const search = useSearch({ strict: false });
  const { token } = search as any;

  return <VerifyEmail token={token as string} />;
};

export default VerifyEmailPage;
