import { Box, Stack } from '@mui/joy';
import React from 'react';
import CallToAction from './CallToAction';

interface CallToActionDetails {
  buttonText: string;
  buttonColor: 'primary' | 'secondary' | 'success' | 'danger' | 'warning';
  title?: string;
  description?: string;
  onButtonClick: () => void;
  iconDecorator: React.ReactNode;
}

interface CallToActionConfig {
  slim: CallToActionDetails[];
  full: CallToActionDetails[];
  float: CallToActionDetails[];
}

export const CallToActionManager: React.FC = () => {
  const grokToolCallToActions: CallToActionConfig = {
    slim: [
      /*
      {
        buttonText: 'Credits!',
        buttonColor: 'secondary',
        onButtonClick: handleMoreCreditsClick,
        iconDecorator: <MonetizationOnIcon />,
      },
      { buttonText: 'Invite', buttonColor: 'secondary', onButtonClick: toggleModal, iconDecorator: <PersonAddIcon /> },
      */
    ],
    full: [],
    float: [
      /*
      {
        title: 'Go Premium!',
        description: 'Receive all premium benefits!',
        buttonText: 'Subscribe',
        buttonColor: 'success',
        onButtonClick: handleSubscribeClick,
        iconDecorator: null,
      },
      */
    ],
  };

  const callToActions = grokToolCallToActions;

  const [visibleFullCallToActions, setVisibleFullCallToActions] = React.useState(
    callToActions.full.map((_, index) => true)
  );
  const [visibleFloatCallToActions, setVisibleFloatCallToActions] = React.useState(
    callToActions.float.map((_, index) => true)
  );

  const dismissAction = (type: 'full' | 'float', index: number) => {
    const setAction = type === 'full' ? setVisibleFullCallToActions : setVisibleFloatCallToActions;
    setAction(prevState => {
      const newState = [...prevState];
      newState[index] = false;
      return newState;
    });
  };

  if (callToActions.slim.length === 0 && callToActions.full.length === 0 && callToActions.float.length === 0) {
    return null;
  }

  return (
    <>
      <Box display="flex">
        <Stack direction={'column'} spacing={0} display="flex" sx={{ justifyContent: 'center', width: '100%' }}>
          <Stack direction={'column'} spacing={0} display="flex" sx={{ maxHeight: '38vh', pb: '1px' }}>
            {callToActions.full.map(
              (action, index) =>
                visibleFullCallToActions[index] && (
                  <CallToAction
                    key={`full-${index}`}
                    mode="full"
                    dismissable={true}
                    onDismiss={() => dismissAction('full', index)}
                    {...action}
                  />
                )
            )}
            {callToActions.float.map(
              (action, index) =>
                visibleFloatCallToActions[index] && (
                  <CallToAction
                    key={`float-${index}`}
                    mode="float"
                    dismissable={true}
                    onDismiss={() => dismissAction('float', index)}
                    {...action}
                  />
                )
            )}
          </Stack>
          <Stack
            direction={'row'}
            spacing={'0.625rem'}
            display="flex"
            sx={{ justifyContent: 'space-around', width: '100%', p: '0.625rem' }}
          >
            {callToActions.slim.map((action, index) => (
              <CallToAction key={`slim-${index}`} mode="slim" {...action} />
            ))}
          </Stack>
        </Stack>
      </Box>
    </>
  );
};

export default CallToActionManager;
