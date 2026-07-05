import CloseIcon from '@mui/icons-material/Close';
import { Box } from '@mui/joy';
import Button from '@mui/joy/Button';
import Card from '@mui/joy/Card';
import CardActions from '@mui/joy/CardActions';
import CardContent from '@mui/joy/CardContent';
import IconButton from '@mui/joy/IconButton';
import Typography from '@mui/joy/Typography';
import React from 'react';

interface CallToActionProps {
  mode: 'slim' | 'full' | 'float';
  title?: string;
  description?: string;
  buttonText: string;
  buttonColor: 'primary' | 'secondary' | 'success' | 'danger' | 'warning';
  onButtonClick: () => void;
  dismissable?: boolean;
  onDismiss?: () => void;
  iconDecorator?: React.ReactNode;
}

export const CallToAction: React.FC<CallToActionProps> = ({
  mode,
  title,
  description,
  buttonText,
  buttonColor,
  onButtonClick,
  dismissable,
  onDismiss,
  iconDecorator,
}) => {
  if (mode === 'slim') {
    return (
      <Button
        variant="outlined"
        color={buttonColor}
        onClick={onButtonClick}
        sx={theme => ({ marginX: '2px', backgroundColor: theme.palette.sidenav.blueBack })}
        fullWidth
        startDecorator={iconDecorator}
      >
        {buttonText}
      </Button>
    );
  }

  if (mode === 'full') {
    return (
      <Box sx={{ marginX: '5px', position: 'relative' }}>
        <Card
          variant="outlined"
          color={buttonColor}
          sx={theme => ({
            backgroundColor: theme.palette.sidenav.ctaSubscribe,
          })}
        >
          {dismissable && (
            <IconButton
              variant="plain"
              color="neutral"
              size="sm"
              sx={{ position: 'absolute', top: '2px', right: '2px', zIndex: 9 }}
              onClick={onDismiss}
            >
              <CloseIcon />
            </IconButton>
          )}
          <CardContent>
            <Typography level="h4">{title}</Typography>
            <Typography level="body-md" marginBottom={'-1vh'}>
              {description}
            </Typography>
          </CardContent>
          <CardActions>
            <Button size="sm" variant="solid" color={buttonColor} onClick={onButtonClick}>
              {buttonText}
            </Button>
          </CardActions>
        </Card>
      </Box>
    );
  }

  if (mode === 'float') {
    return (
      <Box
        sx={theme => ({
          position: 'fixed',
          bottom: '4em',
          left: '0.5em',
          zIndex: 9999,
          backgroundColor: theme.palette.background.panel,
        })}
      >
        <Card
          variant="outlined"
          color={buttonColor}
          sx={theme => ({
            backgroundColor: theme.palette.sidenav.ctaSubscribe,
          })}
        >
          {dismissable && (
            <IconButton
              variant="plain"
              color="neutral"
              size="sm"
              sx={{ position: 'absolute', top: '2px', right: '2px', zIndex: 9 }}
              onClick={onDismiss}
            >
              <CloseIcon />
            </IconButton>
          )}
          <CardContent>
            <Typography level="h4">{title}</Typography>
            <Typography level="body-md" marginBottom={'-1vh'}>
              {description}
            </Typography>
          </CardContent>
          <CardActions>
            <Button size="sm" variant="solid" color={buttonColor} onClick={onButtonClick}>
              {buttonText}
            </Button>
          </CardActions>
        </Card>
      </Box>
    );
  }

  return null;
};

export default CallToAction;
