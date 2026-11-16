import VerifyEmail from '@client/app/components/VerifyEmail';
import { getEmailLinkToken } from '@client/app/utils/emailLinkToken';

// The route's beforeLoad has already moved the link's token out of the address (utils/emailLinkToken.ts).
const VerifyEmailPage = () => <VerifyEmail token={getEmailLinkToken('/verify-email') ?? ''} />;

export default VerifyEmailPage;
