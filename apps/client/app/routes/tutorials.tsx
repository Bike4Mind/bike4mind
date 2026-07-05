import { Box } from '@mui/joy';
import FTUESlider from '@client/app/components/Tutorials/FTUESlider';
import { useNavigate } from '@tanstack/react-router';

const TutorialsPage = () => {
  const navigate = useNavigate();

  const handleComplete = () => {
    navigate({ to: '/' });
  };

  return (
    <Box
      sx={{
        height: '100vh',
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme => theme.palette.background.body,
      }}
    >
      <FTUESlider onComplete={handleComplete} />
    </Box>
  );
};

export default TutorialsPage;
