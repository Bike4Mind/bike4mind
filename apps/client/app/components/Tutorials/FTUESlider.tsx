import React, { useState } from 'react';
import { Box, Typography, IconButton, Sheet } from '@mui/joy';
import KeyboardArrowLeftIcon from '@mui/icons-material/KeyboardArrowLeft';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import { useMediaQuery } from '@mui/system';
import { APP_NAME } from '@client/config/general';

const Emphasis = ({ children }: { children: React.ReactNode }) => {
  return (
    <Box component="span" sx={theme => ({ color: theme.palette.text.secondary, fontWeight: '500' })}>
      {children}
    </Box>
  );
};
const slides = [
  {
    // brand externalized
    title: APP_NAME ? `Welcome to ${APP_NAME}` : 'Welcome',
    description:
      "Your AI-powered notebook for creative thinking and problem solving. Let's get you started with a quick tour.",
    image: '/images/ftue/welcome.png',
  },
  {
    title: 'Notebooks and prompts',
    description: (
      <>
        <Box display="flex" flexDirection={'column'} gap="16px" sx={{ lineHeight: '24px' }}>
          Get started on your first conversation with AI!
          <Box>
            <Emphasis>1. Create a new notebook</Emphasis> by clicking <Emphasis>“New Chat” button</Emphasis> in the
            sidebar to the left.
          </Box>
          <Box>
            <Emphasis>
              2. Click AI Settings button in the prompt input area and select one of the 25+ language models
            </Emphasis>{' '}
            {/* brand externalized */}
            {APP_NAME ? `${APP_NAME} has in store.` : 'available.'}
          </Box>
          <Box>
            <Emphasis>3. Start a conversation using the chat</Emphasis> and ask about anything that you need help with.
          </Box>
        </Box>
      </>
    ),
    image: '/images/ftue/notebooks.png',
  },
  {
    title: 'Files',
    description: (
      <>
        <Box fontSize="16px" lineHeight="24px">
          <Box mb={'16px'}>
            A smart way to get better responses is to share Files with the AI. It will then read the file and use it as
            context during your conversation. This helps you get answers tailored to your topic.
          </Box>
          <Box mb={'16px'}>To use a File, Notebook you want to use the File on.</Box>
          <Box>
            <Box display="flex" alignItems="top" gap="10px">
              <Box flexShrink={0}>
                <Emphasis>1.</Emphasis>
              </Box>
              <Emphasis>Upload the file using the Files modal.</Emphasis>
            </Box>
            <Box display="flex" alignItems="top" gap="10px">
              <Box flexShrink={0}>
                <Emphasis>2.</Emphasis>
              </Box>
              <Box>
                Next, <Emphasis>select the File(s) and add it to your conversation.</Emphasis> The conversation will now
                consider the content of the file for their future responses.
              </Box>
            </Box>
            <Box display="flex" alignItems="top" gap="10px">
              <Box flexShrink={0}>
                <Emphasis>3.</Emphasis>
              </Box>
              <Box>
                You can enter{' '}
                <Emphasis>
                  File Viewer Mode by by clicking on &quot;Attached files&quot; button in the chat area.
                </Emphasis>
              </Box>
            </Box>
          </Box>
        </Box>
      </>
    ),
    image: '/images/ftue/files.png',
  },
  {
    title: 'Sharing',
    description: (
      <Box fontSize="16px" lineHeight="24px">
        <Box display="flex" alignItems="top" gap="10px">
          <Box flexShrink={0}>
            <Emphasis>1.</Emphasis>
          </Box>
          <Box>
            You can also <Emphasis>share specific Notebooks or Files to other users</Emphasis> by selecting Share under
            the three-dot option.
          </Box>
        </Box>
        <Box display="flex" alignItems="top" gap="10px">
          <Box flexShrink={0}>
            <Emphasis>2.</Emphasis>
          </Box>
          <Box>
            Enter the email address or the username of the person you are sharing it to, add a description, and click
            Share. <Emphasis>Recipients may accept your shared item and start using them as their own.</Emphasis>
          </Box>
        </Box>
      </Box>
    ),
    image: '/images/ftue/sharing.png',
  },
  {
    title: 'Projects',
    description: (
      <Box display="flex" flexDirection={'column'} gap="16px" sx={{ lineHeight: '24px' }}>
        <Box>
          You might end up with too many notebooks talking about the same thing since having just one Notebook might not
          do when working on big projects. Feature help group Notebooks and Files together.
        </Box>
        <Box>
          <Box display="flex" alignItems="top" gap="10px">
            <Box>
              <Emphasis>1.</Emphasis>
            </Box>
            <Emphasis>Enter The Projects screen using Projects button on sidenav.</Emphasis>
          </Box>
          <Box display="flex" alignItems="top" gap="10px">
            <Box>
              <Emphasis>2.</Emphasis>
            </Box>
            <Box>
              <Emphasis>Create a Project</Emphasis> by clicking New Project button in the top right.
            </Box>
          </Box>
          <Box display="flex" alignItems="top" gap="10px">
            <Box>
              <Emphasis>3.</Emphasis>
            </Box>
            <Box>
              <Emphasis>Click a project to enter a management view</Emphasis> and add notebooks, files and new members!
            </Box>
          </Box>
        </Box>
      </Box>
    ),
    image: '/images/ftue/projects.png',
  },
  {
    title: 'Tips',
    description: (
      <>
        <Box component="ul" sx={{ margin: '0', pl: '20px' }}>
          <li>
            Divide your problem into smaller segments to get better results. Even better, ask the AI to divide the big
            task for you and focus on each of them one at a time.
          </li>
          <li>
            Try the image AI models to generate images for you. You can also ask a text-based AI model to help you with
            your image prompt.
          </li>
          <li>
            Some AI models accept images as Files so be sure to save the ones you like to use them as context later.
          </li>
          <li>
            Notebooks and Files can be added into multiple Projects so you don&apos;t have to recreate them for each
            one.
          </li>
        </Box>
      </>
    ),
    image: '/images/ftue/tips.png',
  },
];

interface FTUESliderProps {
  onComplete?: () => void;
}

const FTUESlider: React.FC<FTUESliderProps> = ({ onComplete }) => {
  const [currentSlide, setCurrentSlide] = useState(0);
  const isMobile = useMediaQuery('(max-width:768px)');

  const goToNextSlide = () => {
    if (currentSlide === slides.length - 1) {
      setCurrentSlide(0);
    } else {
      setCurrentSlide(prev => prev + 1);
    }
  };

  const goToPrevSlide = () => {
    if (currentSlide > 0) {
      setCurrentSlide(prev => prev - 1);
    }
  };

  const goToSlide = (index: number) => {
    setCurrentSlide(index);
  };

  return (
    <Sheet
      variant="outlined"
      sx={{
        width: '90%',
        maxWidth: isMobile ? '100%' : 'unset',
        height: isMobile ? 'calc(100vh - 32px)' : '720px',
        maxHeight: isMobile ? 'calc(100vh - 32px)' : '720px',
        // Dark mode matches the sidebar surface; light mode keeps the Sheet default.
        backgroundColor: theme => (theme.palette.mode === 'dark' ? theme.palette.background.surface2 : undefined),
        borderRadius: '12px',
        overflow: 'hidden',
        boxShadow: 'lg',
        display: 'flex',
        flexDirection: 'column',
        m: isMobile ? '16px' : 'auto',
        // Positioning context for the corner close button.
        position: 'relative',
      }}
    >
      {/* Dismiss the tutorial - leads to a fresh session (New Chat), wired via onComplete. */}
      <IconButton
        data-testid="tutorial-close-btn"
        aria-label="Close tutorial"
        variant="plain"
        color="neutral"
        size="sm"
        onClick={() => onComplete?.()}
        sx={theme => ({
          position: 'absolute',
          top: 12,
          right: 12,
          zIndex: 10,
          // Transparent at rest and on hover; only the icon tint changes (tertiary -> primary).
          // Joy SvgIcons read --Icon-color, not `color`, so tint via that variable.
          backgroundColor: 'transparent',
          '--Icon-color': theme.palette.text.tertiary,
          '& svg': { transition: 'color 0.2s ease' },
          '&:hover': {
            backgroundColor: 'transparent',
            '--Icon-color': theme.palette.text.primary,
          },
        })}
      >
        <CloseRoundedIcon />
      </IconButton>
      <Box
        sx={{
          display: 'flex',
          flexDirection: isMobile ? 'column' : 'row',
          height: '100%',
          position: 'relative',
          overflow: isMobile ? 'auto' : 'visible',
          justifyContent: 'space-between',
        }}
      >
        {/* Image Section - Top on mobile */}
        {isMobile && (
          <Box
            sx={{
              width: '100%',
              height: '35vh',
              minHeight: '200px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              position: 'relative',
              backgroundColor: 'neutral.500',
              borderRadius: '12px 12px 0 0',
            }}
          >
            {slides.map(
              (slide, index) =>
                slide.image && (
                  <Box
                    key={index}
                    component="img"
                    src={slide.image}
                    alt={slide.title}
                    sx={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'contain',
                      position: 'absolute',
                      opacity: index === currentSlide ? 1 : 0,
                      transition: 'opacity 0.5s ease-in-out',
                    }}
                  />
                )
            )}
          </Box>
        )}

        {/* Content Section - Bottom on mobile, Left on desktop */}
        <Box
          sx={{
            width: isMobile ? '100%' : '480px',
            padding: isMobile ? 3 : 4,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            flex: isMobile ? '1 1 auto' : 'none',
            minHeight: isMobile ? '50vh' : 'auto',
          }}
        >
          {/* Slider indicators */}
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: isMobile ? 2 : 4 }}>
            <Box sx={{ display: 'flex', gap: 1, justifyContent: isMobile ? 'center' : 'flex-start' }}>
              {slides.map((_, index) => (
                <Box
                  key={index}
                  onClick={() => goToSlide(index)}
                  sx={theme => ({
                    width: isMobile ? '30px' : '40px',
                    height: '8px',
                    borderRadius: '3px',
                    backgroundColor: index === currentSlide ? 'primary.500' : 'transparent',
                    border: '1px solid',
                    borderColor: index === currentSlide ? 'primary.500' : theme.palette.neutral[300],
                    opacity: index === currentSlide ? 1 : 0.5,
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                  })}
                />
              ))}
            </Box>

            {/* Content */}
            <Box
              sx={{
                display: 'flex',
                flexDirection: 'column',
                flex: isMobile ? '1 1 auto' : 'none',
                overflow: 'auto',
                maxHeight: isMobile ? 'calc(50vh - 50px)' : 'none',
              }}
            >
              <Typography level="h2" sx={{ mb: 2, fontSize: isMobile ? '1.5rem' : '2rem' }}>
                {slides[currentSlide].title}
              </Typography>
              <Typography level="body-md" color="neutral">
                {slides[currentSlide].description}
              </Typography>
            </Box>
          </Box>

          {/* Navigation buttons */}
          <Box
            sx={{
              display: 'flex',
              gap: 1,
              justifyContent: isMobile ? 'center' : 'flex-start',
              mt: isMobile ? 2 : 0,
              mb: isMobile ? 2 : 0,
            }}
          >
            <IconButton
              variant="outlined"
              color="neutral"
              onClick={goToPrevSlide}
              disabled={currentSlide === 0}
              sx={{ width: '60px', height: '32px' }}
            >
              <KeyboardArrowLeftIcon />
            </IconButton>

            <IconButton
              variant="outlined"
              color="neutral"
              onClick={goToNextSlide}
              sx={{ width: '60px', height: '32px' }}
              disabled={currentSlide === slides.length - 1}
            >
              <KeyboardArrowRightIcon />
            </IconButton>
          </Box>
        </Box>

        {/* Desktop Image Section - Right side */}
        {!isMobile && (
          <Box
            sx={{
              width: '840px',
              height: '660px',
              display: 'flex',
              alignItems: 'center',
              position: 'relative',
              m: '30px',
            }}
          >
            {slides.map(
              (slide, index) =>
                slide.image && (
                  <Box
                    key={index}
                    component="img"
                    src={slide.image}
                    alt={slide.title}
                    sx={{
                      width: '100%',
                      height: '100%',
                      borderRadius: '12px',
                      objectFit: 'contain',
                      position: 'absolute',
                      opacity: index === currentSlide ? 1 : 0,
                      transition: 'opacity 0.5s ease-in-out',
                    }}
                  />
                )
            )}
          </Box>
        )}
      </Box>
    </Sheet>
  );
};

export default FTUESlider;
