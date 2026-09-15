import { FC } from 'react';
import { Box, Button } from '@mui/joy';
import AddIcon from '@mui/icons-material/Add';
import { useNavigate } from '@tanstack/react-router';

interface CreateAgentButtonProps {
  variant?: 'header' | 'empty';
  testId?: string;
}

const CreateAgentButton: FC<CreateAgentButtonProps> = ({ variant = 'header', testId }) => {
  const navigate = useNavigate();

  const buttonText = variant === 'header' ? 'New Agent' : 'Create your first agent';
  const buttonSx =
    variant === 'header'
      ? {
          whiteSpace: 'nowrap',
          minWidth: { xs: '32px', sm: '140px' },
          maxWidth: { xs: '32px', sm: 'auto' },
          minHeight: 'auto',
          height: '32px',
          maxHeight: '32px',
          px: { xs: '8px', sm: 2 },
          '& .MuiButton-startDecorator': {
            marginRight: { xs: '0px !important', sm: '8px !important' },
          },
        }
      : {
          alignSelf: 'center',
        };

  return (
    <Button
      data-testid={testId || 'create-agent-btn'}
      sx={buttonSx}
      startDecorator={
        <Box
          sx={{
            width: 24,
            height: 24,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            ...(variant === 'empty' && { alignSelf: 'center' }),
          }}
        >
          <AddIcon sx={{ m: 0 }} />
        </Box>
      }
      onClick={() => navigate({ to: '/agents/new' })}
      color="primary"
    >
      <Box
        sx={{
          display: { xs: 'none', sm: 'block' },
        }}
      >
        {buttonText}
      </Box>
    </Button>
  );
};

export default CreateAgentButton;
