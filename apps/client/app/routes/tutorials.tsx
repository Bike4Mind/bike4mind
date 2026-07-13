import { Box } from '@mui/joy';
import FTUESlider from '@client/app/components/Tutorials/FTUESlider';
import { useNavigate } from '@tanstack/react-router';

const TutorialsPage = () => {
  const navigate = useNavigate();

  // Dismissing the tutorial behaves like the sidebar "New Chat" button: a blank session view.
  const handleComplete = () => {
    navigate({ to: '/new' });
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
