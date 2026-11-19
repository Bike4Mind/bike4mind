import { Alert, Typography } from '@mui/joy';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { FC } from 'react';
import { useTranslation } from 'react-i18next';

interface OwnerOnlyNoteProps {
  /** What only the owner can do, as a sentence fragment: "Changing the plan and seats". */
  children: string;
  testId: string;
}

/**
 * Stands in for an owner-only control a manager cannot use, so the section explains itself instead of
 * rendering nothing or offering an action that would fail.
 */
const OwnerOnlyNote: FC<OwnerOnlyNoteProps> = ({ children, testId }) => {
  const { t } = useTranslation();
  return (
    <Alert variant="soft" color="neutral" startDecorator={<LockOutlinedIcon />} data-testid={testId}>
      <Typography level="body-sm">
        <Typography fontWeight="lg">{t('organization.access_notice.owner_only_label')}</Typography>{' '}
        {t('organization.access_notice.owner_only_detail', { what: children, interpolation: { escapeValue: false } })}
      </Typography>
    </Alert>
  );
};

export default OwnerOnlyNote;
