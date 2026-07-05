import { useReferralModal } from '@client/app/components/referrals/ReferralModal';
import PersonAddIcon from '@mui/icons-material/PersonAdd';
import { Button, IconButton, Tooltip } from '@mui/joy';
import { useTranslation } from 'react-i18next';

interface ReferralButtonProps {
  slim?: boolean;
}

const ReferralButton: React.FC<ReferralButtonProps> = ({ slim }) => {
  const toggleModal = useReferralModal(s => s.toggle);
  const { t } = useTranslation();

  return (
    <>
      {!slim && (
        <Tooltip title={t('inviteLong')}>
          <Button startDecorator={<PersonAddIcon />} onClick={toggleModal} sx={{ width: '8rem' }}>
            {t('inviteShort')}
          </Button>
        </Tooltip>
      )}
      {slim && (
        <Tooltip title={t('inviteLong')}>
          <IconButton onClick={toggleModal}>
            <PersonAddIcon />
          </IconButton>
        </Tooltip>
      )}
    </>
  );
};

export default ReferralButton;
