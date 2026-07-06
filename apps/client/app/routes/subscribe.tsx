import React from 'react';
import { Stack, Typography, Box } from '@mui/joy';
import SubscriberForm from '@client/app/components/SubscriberForm';
import { useTheme } from '@mui/joy/styles';
import Image from 'next/image';
import useGetLogo from '@client/app/hooks/useGetLogo';

const lines = [
  {
    firstPhrase: 'Hop aboard the Bike4Mind express 🚂',
    secondPhrase:
      "—because if we don't automate our jobs, someone else will (and they might not share their coffee ☕).",
  },
  {
    firstPhrase: "Embark on a quest to shape AI's future 🤖",
    secondPhrase: "—before it shapes ours (in ways we didn't quite expect 🌐).",
  },

  {
    firstPhrase: 'Join us in forging the AI of tomorrow 🔨',
    secondPhrase: "—and let's be honest, it's so we can work smarter, not harder 💡.",
  },
  {
    firstPhrase: 'Dive into the AI revolution with us 🌊',
    secondPhrase: "—we're figuring out how to make machines do our bidding (responsibly, of course 🤝).",
  },
  {
    firstPhrase: 'Step into the AI frontier 🌌',
    secondPhrase: "—where we're as likely to automate our coffee breaks ☕ as our code 💻.",
  },
  {
    firstPhrase: 'Take the leap into AI innovation 🐸',
    secondPhrase: "—because it's better to be the coder than the coded 👨‍💻👩‍💻.",
  },
  {
    firstPhrase: 'Embark on this journey with us 🚀',
    secondPhrase: '—where we might just automate our own roles (but hey, more time for hobbies! 🎨🎮).',
  },
  {
    firstPhrase: 'Join the Bike4Mind adventure 🧭',
    secondPhrase: "—navigating the AI maze so we don't end up making the tea for robots 🤖🍵.",
  },
  {
    firstPhrase: "Let's ride the AI wave together 🏄‍♂️",
    secondPhrase: "—because if we don't, we might just be left coding 'Hello World' for smart toasters 🍞.",
  },
  {
    firstPhrase: 'Step into the future of AI with us 🚪',
    secondPhrase: '—where our biggest challenge might be teaching robots to appreciate a good joke 😂.',
  },
];

const randomLine = lines[Math.floor(Math.random() * lines.length)];

// Reusable styles
const styles = {
  heading: (theme: any) => ({
    fontSize: { xs: '20px', sm: '24px' },
    fontWeight: 400,
    color: theme.palette.text.primary,
    textAlign: 'center',
    px: 2,
  }),
  listItem: (theme: any) => ({
    justifyContent: 'center',
    p: { xs: 1, sm: 0 },
    color: theme.palette.text.primary,
    textAlign: 'center',
    px: 2,
  }),
  subscribeText: (theme: any) => ({
    color: theme.palette.text.primary,
    opacity: 0.3,
    fontSize: '12px',
    textAlign: 'center',
    mt: 2,
    px: 2,
  }),
};

const SubscribePage = () => {
  const theme = useTheme();
  const logoUrl = useGetLogo();

  return (
    <Box
      sx={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: '100vh',
        p: { xs: 2, sm: 3 },
      }}
    >
      <Box
        display="flex"
        flexDirection="column"
        justifyContent="center"
        alignItems="center"
        sx={{
          minHeight: '40vh',
          maxWidth: '900px',
          width: '100%',
        }}
      >
        <Box
          sx={{
            position: 'relative',
            width: { xs: 60, sm: 80 },
            height: { xs: 60, sm: 80 },
            mb: 2,
          }}
        >
          <Image src={logoUrl} alt={`${theme.branding.name} logo`} fill style={{ objectFit: 'contain' }} />
        </Box>

        <Typography level="h3" sx={[styles.heading, { mt: 2 }]}>
          {randomLine.firstPhrase}
        </Typography>

        <Typography level="h3" sx={styles.heading}>
          {randomLine.secondPhrase}
        </Typography>

        <Stack
          spacing={0}
          sx={{
            my: { xs: 3, sm: 4 },
            width: '100%',
            maxWidth: '600px',
          }}
        >
          <Typography sx={styles.listItem}>🚀 Get exclusive beta access to cutting-edge features</Typography>
          <Typography sx={styles.listItem}>🌱 Grow with a community of forward-thinking developers</Typography>
          <Typography sx={styles.listItem}>🔍 Be the first to explore innovative AI tools</Typography>
        </Stack>

        <Box sx={{ width: '100%' }}>
          <SubscriberForm />
        </Box>

        <Typography level="body-sm" sx={styles.subscribeText}>
          SUBSCRIBE NOW TO RECEIVE YOUR INVITE CODE.
        </Typography>
      </Box>
    </Box>
  );
};

export default SubscribePage;
