import { Link, Typography } from '@mui/joy';
import { ExternalLinks } from '@client/app/utils/externalLinks';

interface ContactSalesNoteProps {
  /** Yields `<prefix>-contact-sales` and `<prefix>-contact-sales-link` test ids and the matching class name. */
  testIdPrefix: string;
  /** Top margin in theme spacing units. */
  mt?: number;
}

/** Points teams that need a PO, invoice or other custom billing at the support contact. */
const ContactSalesNote = ({ testIdPrefix, mt = 0.5 }: ContactSalesNoteProps) => (
  <Typography
    level="body-xs"
    sx={{ mt }}
    className={`${testIdPrefix}-contact-sales`}
    data-testid={`${testIdPrefix}-contact-sales`}
  >
    Need a PO, invoice, or other custom billing?{' '}
    <Link
      href={ExternalLinks.support}
      target="_blank"
      rel="noopener noreferrer"
      data-testid={`${testIdPrefix}-contact-sales-link`}
    >
      Contact us
    </Link>
    .
  </Typography>
);

export default ContactSalesNote;
