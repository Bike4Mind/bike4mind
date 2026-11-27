import VerifyEmail from '@client/app/components/VerifyEmail';
import { getEmailLinkToken, VERIFY_EMAIL_PATH } from '@client/app/utils/emailLinkToken';

// router.tsx has already moved the link's token out of the address (utils/emailLinkToken.ts).
const VerifyEmailPage = () => <VerifyEmail token={getEmailLinkToken(VERIFY_EMAIL_PATH) ?? ''} />;

export default VerifyEmailPage;
