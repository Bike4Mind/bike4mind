import VerifyEmailChange from '@client/app/components/VerifyEmailChange';
import { getEmailLinkToken } from '@client/app/utils/emailLinkToken';

// The route's beforeLoad has already moved the link's token out of the address (utils/emailLinkToken.ts).
const VerifyEmailChangePage = () => <VerifyEmailChange token={getEmailLinkToken('/verify-change') ?? ''} />;

export default VerifyEmailChangePage;
