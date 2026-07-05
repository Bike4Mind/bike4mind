import { Box, Typography } from '@mui/joy';
import ScienceIcon from '@mui/icons-material/Science';
import { useTranslation } from 'react-i18next';
import ExperimentalFeatureToggle from './ExperimentalFeatureToggle';
import SectionContainer from './SectionContainer';

const ExperimentalFeaturesTabContent = () => {
  const { t } = useTranslation();

  return (
    <Box className="experimental-features-container" sx={{ p: 1 }}>
      {/* Header */}
      <Typography
        className="experimental-features-header"
        level="h3"
        sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}
      >
        <ScienceIcon /> {t('settings.experimental_features.header')}
      </Typography>

      <SectionContainer
        title={t('settings.experimental_features.beta_features.title')}
        subtitle={t('settings.experimental_features.beta_features.subtitle')}
      >
        <ExperimentalFeatureToggle />
      </SectionContainer>
    </Box>
  );
};

export default ExperimentalFeaturesTabContent;
