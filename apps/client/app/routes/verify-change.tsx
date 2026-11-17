import VerifyEmailChange from '@client/app/components/VerifyEmailChange';
import { getEmailLinkToken, VERIFY_EMAIL_CHANGE_PATH } from '@client/app/utils/emailLinkToken';

// router.tsx has already moved the link's token out of the address (utils/emailLinkToken.ts).
const VerifyEmailChangePage = () => <VerifyEmailChange token={getEmailLinkToken(VERIFY_EMAIL_CHANGE_PATH) ?? ''} />;

export default VerifyEmailChangePage;
