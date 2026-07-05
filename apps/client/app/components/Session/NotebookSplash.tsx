import { useUser } from '@client/app/contexts/UserContext';
import { useGetModals } from '@client/app/hooks/data/modals';
import { Card, CardContent, Tooltip } from '@mui/joy';
import Box from '@mui/joy/Box';
import Typography from '@mui/joy/Typography';
import { keyframes } from '@mui/system';
import dayjs from 'dayjs';
import NextImage from 'next/image';
import React, { useMemo, useState, useEffect, useCallback, useRef } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import useGetLogo from '@client/app/hooks/useGetLogo';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import { useChatInput } from '@client/app/hooks/useChatInput';
import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { useQueryClient } from '@tanstack/react-query';
import type { ISessionDocument } from '@bike4mind/common';
import type { SkyGreetingResponse } from '@client/pages/api/sky-greeting/index';
import { brandAlpha, gray } from '@client/app/utils/themes/colors';
import { APP_NAME } from '@client/config/general';

// Shake animation for the magic 8-ball logo
const shakeAnimation = keyframes`
  0%, 100% { transform: rotate(0deg); }
  10%, 30%, 50%, 70%, 90% { transform: rotate(-8deg); }
  20%, 40%, 60%, 80% { transform: rotate(8deg); }
`;

// Oblique Strategies - Brian Eno-inspired creative prompts
const OBLIQUE_STRATEGIES = [
  'Honor thy error as a hidden intention',
  'What would your closest friend do?',
  'Do nothing for as long as possible',
  'Gardening, not architecture',
  'Make a blank valuable by putting it in an exquisite frame',
  'Remove specifics and convert to ambiguities',
  'Ask your body',
  'Use an old idea',
  'State the problem in words as clearly as possible',
  'Only one element of each kind',
  'What would you do if you had more time?',
  'What mistakes did you make last time?',
  "What wouldn't you do?",
  'Emphasize the flaws',
  'What is the reality of the situation?',
  'Simple subtraction',
  'Go slowly all the way round the outside',
  'A line has two sides',
  'Make an exhaustive list of everything you might do and do the last thing on the list',
  'Into the impossible',
  'Work at a different speed',
  'Twist the spine',
  'Look at the order in which you do things',
  'Change instrument roles',
  'Accept advice',
  'Abandon normal instruments',
  'Take away the elements in order of apparent non-importance',
  'Infinitesimal gradations',
  'Change nothing and continue with immaculate consistency',
  'The tape is now the music',
  'Faced with a choice, do both',
  'What are you really thinking about just now?',
  'Discover the recipes you are using and abandon them',
  'Reverse',
  'Go outside. Shut the door.',
  'Trust in the you of now',
  'What is the simplest solution?',
  "Don't be afraid of things because they're easy to do",
  "Don't be frightened of cliches",
  'What would make this really special?',
  'Retrace your steps',
  'Turn it upside down',
  'Think of the radio',
  'Do we need holes?',
  'Courage!',
  'Spectrum analysis',
  'Not building a wall but making a brick',
  'Use "unqualified" people',
  'What context would look right?',
  'Tidy up',
];

// Agency prompts - empowering questions that put the user in control
const AGENCY_PROMPTS = [
  'Help me break down a complex problem into steps',
  "Help me draft a plan for something I've been putting off",
  'I need to make a decision — help me think through the tradeoffs',
  'Help me prioritize my tasks for today',
  'I have a rough idea — help me refine it',
  "Summarize a topic I'm researching",
  "Help me write something — I'll tell you what",
  'Review my thinking on something and poke holes in it',
  'Help me organize my scattered notes into something clear',
  "I'm stuck — help me figure out my next step",
];

// Contextual quips - time-aware, playful prompts
const CONTEXTUAL_QUIPS = {
  monday: ['Help me plan my week', 'What should I focus on this week?'],
  tuesday: ["Help me tackle something I've been avoiding", "Let's make progress on a current project"],
  wednesday: ['Help me check in on my goals for this week', "Midweek — let's course-correct if needed"],
  thursday: ['Help me prepare for the end of the week', 'What should I wrap up before Friday?'],
  friday: ['Help me write a weekly recap', 'What did I accomplish this week?'],
  saturday: ['Help me explore a side project idea', "Let's dive into something creative"],
  sunday: ['Help me plan ahead for next week', "Let's organize my thoughts before Monday"],
  morning: [
    'Help me outline my priorities for today',
    'What should I focus on this morning?',
    "Help me get started on today's most important task",
  ],
  afternoon: ['Help me push through my afternoon tasks', "Let's revisit what I started this morning"],
  evening: ['Help me reflect on what went well today', "Let's wrap up today's loose ends"],
  lateNight: [
    'Help me capture this late-night idea before I forget',
    "Let's think through something quietly",
    "Help me draft something while it's fresh in my mind",
  ],
};

// Explore prompts - discovery-oriented prompts for the Explore card fallback
const EXPLORE_PROMPTS = [
  "Explain a topic I'm curious about in a new way",
  "Surprise me with an interesting idea I haven't considered",
  "Help me brainstorm — I'll give you a starting point",
  'Teach me something new about a subject I pick',
  "Help me explore a 'what if' scenario",
  "Let's have a creative jam session",
];

// Single-notebook prompts - remix and synthesis using a single notebook
const SINGLE_NOTEBOOK_REMIX_TEMPLATES = [
  (name: string) => `Revisit "${name}" from a completely different angle`,
  (name: string) => `Apply the principles of "${name}" to a new domain — what happens?`,
  (name: string) => `What if you approached "${name}" as a beginner? What would you see differently?`,
  (name: string) => `Take "${name}" and flip its core assumption upside down`,
  (name: string) => `Remix "${name}" — what would it look like in a different format?`,
  (name: string) => `What would "${name}" look like if you started from scratch today?`,
];

const SINGLE_NOTEBOOK_SYNTHESIS_TEMPLATES = [
  (name: string) => `What are the key insights from "${name}"?`,
  (name: string) => `Summarize the core ideas in "${name}" and identify what's missing`,
  (name: string) => `What patterns or themes emerge from "${name}"?`,
  (name: string) => `Distill "${name}" into its essential principles`,
  (name: string) => `What would a sequel to "${name}" explore?`,
  (name: string) => `What questions does "${name}" leave unanswered?`,
];

// Utility functions
type CardSlotType = 'connect' | 'remix' | 'synthesis' | 'oblique' | 'focus' | 'rightNow';

const ALL_CARD_SLOT_TYPES: CardSlotType[] = ['connect', 'remix', 'synthesis', 'oblique', 'focus', 'rightNow'];

/** Pick 4 random card types from the available pool.
 * Notebook-dependent types (connect, remix, synthesis) fall back to standalone
 * alternatives in the render, so deduplication handles the no-notebooks case. */
function pickCardSlots(): CardSlotType[] {
  return shuffleArray(ALL_CARD_SLOT_TYPES).slice(0, 4);
}

function randomFrom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Fisher-Yates shuffle - produces a truly uniform random permutation
 * Unlike sort(() => Math.random() - 0.5), this algorithm has no bias
 */
function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function getTimeOfDayGreeting(): string {
  const hour = new Date().getHours();

  if (hour < 5) return randomFrom(['A most peaceful late night', 'Burning the midnight oil', 'The quiet hours']);
  if (hour < 12) return randomFrom(['Good morning', 'Rise and shine', 'Morning']);
  if (hour < 17) return randomFrom(['Good afternoon', 'Afternoon', 'Hope your day is going well']);
  if (hour < 22) return randomFrom(['Good evening', 'Evening', 'Winding down']);
  return randomFrom(['Late night thoughts', 'Burning the midnight oil', 'Night owl hours']);
}

function getContextualQuip(): string {
  const now = new Date();
  const hour = now.getHours();
  const day = now.getDay();

  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
  const dayName = days[day];

  // Time-based quips take priority for early morning and late night
  if (hour < 5) return randomFrom(CONTEXTUAL_QUIPS.lateNight);
  if (hour < 12) return randomFrom(CONTEXTUAL_QUIPS.morning);
  if (hour >= 22) return randomFrom(CONTEXTUAL_QUIPS.lateNight);

  // Otherwise, use day-based quips
  return randomFrom(CONTEXTUAL_QUIPS[dayName]);
}

// Splash card component
interface SplashCardProps {
  icon: string;
  title: string;
  description: string;
  onClick: () => void;
  source?: string;
  sourceUrl?: string;
  subtitle?: string;
}

const SplashCard: React.FC<SplashCardProps> = ({ icon, title, description, onClick, source, sourceUrl, subtitle }) => {
  return (
    <Card
      variant="outlined"
      sx={{
        cursor: 'pointer',
        transition: 'all 0.2s ease',
        borderColor: theme => (theme.palette.mode === 'light' ? gray[200] : brandAlpha[100][8]),
        backgroundColor: theme => (theme.palette.mode === 'light' ? '#FFFFFF' : 'background.surface2'),
        '@media (hover: hover)': {
          '&:hover': {
            borderColor: 'primary.400',
            backgroundColor: theme => (theme.palette.mode === 'light' ? brandAlpha[500][5] : brandAlpha[500][10]),
            transform: 'translateY(-2px)',
            boxShadow: 'sm',
          },
          '&:active': {
            transform: 'translateY(0)',
          },
        },
        height: '100%',
      }}
      onClick={onClick}
    >
      <CardContent sx={{ p: 0, height: '100%', display: 'flex', flexDirection: 'column' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          <Box
            component="span"
            sx={{ fontSize: '18px', lineHeight: 1, flexShrink: 0, display: 'inline-block', color: 'inherit' }}
            dangerouslySetInnerHTML={{ __html: icon }}
          />
          <Typography sx={{ color: 'text.tertiary', fontSize: '13px', fontWeight: 500 }}>{title}</Typography>
        </Box>
        <Typography
          sx={{
            color: 'text.primary',
            fontSize: '13px',
            lineHeight: 1.5,
          }}
        >
          {description}
        </Typography>
        {subtitle && (
          <Typography level="body-xs" sx={{ mt: 0.5, color: 'text.tertiary' }}>
            {subtitle}
          </Typography>
        )}
        {source && (
          <Typography
            level="body-xs"
            component={sourceUrl ? 'a' : 'span'}
            href={sourceUrl}
            target={sourceUrl ? '_blank' : undefined}
            rel={sourceUrl ? 'noopener noreferrer' : undefined}
            onClick={sourceUrl ? (e: React.MouseEvent) => e.stopPropagation() : undefined}
            sx={{
              mt: 1,
              color: 'text.tertiary',
              fontStyle: 'italic',
              textDecoration: 'none',
              '@media (hover: hover)': {
                '&:hover': sourceUrl
                  ? {
                      color: 'primary.400',
                      textDecoration: 'underline',
                    }
                  : {},
              },
            }}
          >
            — {source} {sourceUrl && '↗'}
          </Typography>
        )}
      </CardContent>
    </Card>
  );
};

// Mobile splash carousel: on phones the prompt cards live in a horizontally-
// scrollable row where only ~1.5 cards fit. Carousel dots signal that more cards
// exist and let the user tap to jump between them.
const MobileSplashCarousel: React.FC<{ cards: SplashCardProps[] }> = ({ cards }) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const lastIndex = Math.max(cards.length - 1, 0);

  // Map the current scrollLeft onto a card index. Using the scroll ratio keeps
  // this robust to the exact card width / gap math (cards are 85% of the
  // viewport) and to however many cards end up rendered.
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const maxScroll = el.scrollWidth - el.clientWidth;
    if (maxScroll <= 0) {
      setActiveIndex(0);
      return;
    }
    // Clamp before rounding: iOS overscroll/bounce can push scrollLeft below 0
    // or past maxScroll, which would otherwise yield an out-of-range index and
    // leave no dot active.
    const ratio = Math.min(1, Math.max(0, el.scrollLeft / maxScroll));
    setActiveIndex(Math.round(ratio * lastIndex));
  }, [lastIndex]);

  const scrollToIndex = useCallback(
    (i: number) => {
      const el = scrollRef.current;
      if (!el) return;
      const maxScroll = el.scrollWidth - el.clientWidth;
      el.scrollTo({ left: lastIndex > 0 ? (i / lastIndex) * maxScroll : 0, behavior: 'smooth' });
    },
    [lastIndex]
  );

  return (
    <Box sx={{ width: '100%' }}>
      <Box
        ref={scrollRef}
        onScroll={handleScroll}
        sx={{
          display: 'flex',
          overflowX: 'auto',
          scrollSnapType: 'x mandatory',
          WebkitOverflowScrolling: 'touch',
          gap: 1.5,
          px: 1,
          pb: 1,
          scrollbarWidth: 'none',
          '&::-webkit-scrollbar': { display: 'none' },
          width: '100%',
        }}
      >
        {cards.map((card, i) => (
          <Box
            key={i}
            sx={{
              flex: '0 0 85%',
              scrollSnapAlign: 'center',
            }}
          >
            <SplashCard {...card} />
          </Box>
        ))}
      </Box>

      {cards.length > 1 && (
        <Box
          data-testid="splash-carousel-dots"
          sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 0, mt: 0.5 }}
        >
          {cards.map((_, i) => {
            const isActive = i === activeIndex;
            return (
              <Box
                key={i}
                component="button"
                type="button"
                aria-label={`Go to card ${i + 1}`}
                aria-current={isActive ? 'true' : undefined}
                onClick={() => scrollToIndex(i)}
                sx={{
                  // Transparent padded wrapper keeps the visual dot small while
                  // giving touch and keyboard users a 24px+ hit target (WCAG 2.5.8).
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  p: '9px',
                  border: 'none',
                  background: 'none',
                  cursor: 'pointer',
                  borderRadius: '50%',
                  '&:focus-visible': {
                    outline: '2px solid',
                    outlineColor: 'primary.500',
                    outlineOffset: '2px',
                  },
                }}
              >
                <Box
                  aria-hidden
                  sx={{
                    height: '6px',
                    width: isActive ? '18px' : '6px',
                    borderRadius: '3px',
                    backgroundColor: isActive ? 'primary.500' : 'neutral.400',
                    opacity: isActive ? 1 : 0.4,
                    transition: 'width 0.2s ease, opacity 0.2s ease, background-color 0.2s ease',
                  }}
                />
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
};

// Zustand store for announcements
export const useNotebookSplash = create<{
  dismissedAnnouncements: string[];
  dismissAnnouncement: (announcementId: string) => void;
}>()(
  persist(
    set => ({
      dismissedAnnouncements: [],
      dismissAnnouncement: announcementId => {
        set(state => ({
          dismissedAnnouncements: [...state.dismissedAnnouncements, announcementId],
        }));
      },
    }),
    {
      partialize: state => ({
        dismissedAnnouncements: state.dismissedAnnouncements,
      }),
      name: 'notebook-splash',
    }
  )
);

export const useLatestAnnouncement = () => {
  const dismissedAnnouncements = useNotebookSplash(s => s.dismissedAnnouncements);
  const dismissAnnouncement = useNotebookSplash(s => s.dismissAnnouncement);
  const announcements = useGetModals();

  const latestAnnouncement = useMemo(() => {
    if (!announcements.data) return null;

    const now = dayjs();

    return announcements.data.find(
      announcement =>
        !dismissedAnnouncements.includes(announcement.id) &&
        announcement.enabled &&
        now.isAfter(announcement.startDate) &&
        now.isBefore(announcement.endDate)
    );
  }, [announcements.data, dismissedAnnouncements]);

  return {
    latestAnnouncement,
    dismissAnnouncement,
  };
};

// Connect the dots - generate unexpected connections between sessions
interface ConnectTheDotsPrompt {
  text: string;
  sessions: { name: string; id: string }[];
}

function generateConnectTheDotsPrompts(sessions: ISessionDocument[], count: number = 3): ConnectTheDotsPrompt[] {
  // Filter to sessions with meaningful names (not "New Chat")
  const meaningfulSessions = sessions.filter(s => s.name && s.name !== 'New Chat' && s.name.length > 3);

  if (meaningfulSessions.length < 2) return [];

  // Connection prompt templates
  const connectionTemplates = [
    (a: string, b: string) => `What if "${a}" could inform "${b}"?`,
    (a: string, b: string) => `How might the ideas in "${a}" transform "${b}"?`,
    (a: string, b: string) => `What unexpected connection exists between "${a}" and "${b}"?`,
    (a: string, b: string) => `If "${a}" and "${b}" had a conversation, what would emerge?`,
    (a: string, b: string) => `Apply the principles of "${a}" to "${b}" — what happens?`,
    (a: string, b: string) => `"${a}" meets "${b}" — what's the synthesis?`,
    (a: string, b: string) => `What would "${a}" teach "${b}"?`,
    (a: string, b: string) => `Blend "${a}" with "${b}" into something new.`,
    (a: string, b: string) => `The hidden thread between "${a}" and "${b}" is...`,
    (a: string, b: string) => `Remix "${a}" using the lens of "${b}".`,
  ];

  const prompts: ConnectTheDotsPrompt[] = [];
  const usedPairs = new Set<string>();
  const shuffledTemplates = shuffleArray(connectionTemplates);

  // Try to generate unique prompts
  for (let i = 0; i < count && shuffledTemplates.length > 0; i++) {
    // Shuffle sessions for each prompt using Fisher-Yates
    const shuffled = shuffleArray(meaningfulSessions);

    // Find a pair we haven't used yet
    for (let j = 0; j < shuffled.length - 1; j++) {
      for (let k = j + 1; k < shuffled.length; k++) {
        const pairKey = [shuffled[j].id, shuffled[k].id].sort().join('-');
        if (!usedPairs.has(pairKey)) {
          usedPairs.add(pairKey);
          const template = shuffledTemplates.pop()!;
          const text = template(shuffled[j].name, shuffled[k].name);
          prompts.push({
            text,
            sessions: [
              { name: shuffled[j].name, id: shuffled[j].id },
              { name: shuffled[k].name, id: shuffled[k].id },
            ],
          });
          break;
        }
      }
      if (prompts.length > i) break;
    }
  }

  return prompts;
}

const NotebookSplash: React.FC = () => {
  const { currentUser } = useUser();
  const isMobile = useIsMobile();
  const setChatInputValue = useChatInput(s => s.setChatInputValue);
  const queryClient = useQueryClient();

  // Personalized "Connect the Dots" prompts - generated AFTER mount from cached data
  // This avoids useInsertionEffect conflicts by not using React Query hooks directly
  const [connectPrompts, setConnectPrompts] = useState<ConnectTheDotsPrompt[]>([]);

  // Single-notebook prompts for Remix and Synthesis cards
  const [singleNotebookPrompts, setSingleNotebookPrompts] = useState<{
    remix: string | null;
    synthesis: string | null;
  }>({ remix: null, synthesis: null });

  // Which 4 card types to display (randomized on mount and re-roll)
  const [cardSlotTypes, setCardSlotTypes] = useState<CardSlotType[]>(() => pickCardSlots());

  // For the magic 8-ball logo button - track if we're "shaking"
  const [isShaking, setIsShaking] = useState(false);

  // Store all sessions for re-rolling
  const [allSessions, setAllSessions] = useState<ISessionDocument[]>([]);

  // Fetch sky greeting (astronomy data) - deferred until after mount
  const [hasMounted, setHasMounted] = useState(false);
  useEffect(() => {
    setHasMounted(true);

    // Track if component unmounts to prevent memory leaks
    let cancelled = false;
    let timerId: ReturnType<typeof setTimeout> | null = null;

    // After mount, try to generate "Connect the Dots" prompts from cached sessions
    // This runs AFTER MUI's style injection is complete, avoiding useInsertionEffect conflicts
    const generatePersonalizedPrompts = () => {
      if (cancelled) return false;

      try {
        // Try to read from the infinite query cache - get ALL pages for more variety
        const cachedData = queryClient.getQueryData<{
          pages: Array<{ data: ISessionDocument[] }>;
        }>(['sessions', 'own', '']);

        // Collect sessions from all cached pages (up to ~50 sessions)
        const allCachedSessions: ISessionDocument[] = [];
        if (cachedData?.pages) {
          for (const page of cachedData.pages) {
            if (page.data) {
              allCachedSessions.push(...page.data);
            }
            // Limit to ~50 sessions for the magic 8-ball pool
            if (allCachedSessions.length >= 50) break;
          }
        }

        if (allCachedSessions.length >= 2 && !cancelled) {
          // Store sessions for re-rolling via logo click
          setAllSessions(allCachedSessions);

          // Generate only 1 connect prompt (avoids 3/4 cards all connecting notebooks)
          const prompts = generateConnectTheDotsPrompts(allCachedSessions, 1);
          if (prompts.length > 0 && !cancelled) {
            setConnectPrompts(prompts);
          }

          // Generate single-notebook prompts for Remix and Synthesis
          const meaningfulSessions = allCachedSessions.filter(
            s => s.name && s.name !== 'New Chat' && s.name.length > 3
          );
          if (meaningfulSessions.length > 0 && !cancelled) {
            const shuffledForSingle = shuffleArray(meaningfulSessions);
            setSingleNotebookPrompts({
              remix: randomFrom(SINGLE_NOTEBOOK_REMIX_TEMPLATES)(shuffledForSingle[0].name),
              synthesis: randomFrom(SINGLE_NOTEBOOK_SYNTHESIS_TEMPLATES)(
                shuffledForSingle[Math.min(1, shuffledForSingle.length - 1)].name
              ),
            });
          }

          // Randomize card types now that notebooks are available
          if (!cancelled) {
            setCardSlotTypes(pickCardSlots());
          }

          return true; // Success
        }
        return false; // Not enough data yet
      } catch {
        return false;
      }
    };

    // Try immediately after a short delay, then retry a few times
    // The sidebar might still be fetching sessions
    let attempts = 0;
    const maxAttempts = 10;
    const retryInterval = 500; // 500ms between retries

    const tryGenerate = () => {
      if (cancelled) return;
      attempts++;
      const success = generatePersonalizedPrompts();
      if (!success && attempts < maxAttempts && !cancelled) {
        timerId = setTimeout(tryGenerate, retryInterval);
      }
    };

    // Start after initial delay
    timerId = setTimeout(tryGenerate, 100);

    return () => {
      cancelled = true;
      if (timerId !== null) {
        clearTimeout(timerId);
      }
    };
  }, [queryClient]);

  const { data: skyGreeting } = useQuery({
    queryKey: ['sky-greeting'],
    queryFn: async (): Promise<SkyGreetingResponse> => {
      const response = await api.get('/api/sky-greeting');
      return response.data;
    },
    staleTime: 1000 * 60 * 30, // Cache for 30 minutes
    refetchOnWindowFocus: false,
    enabled: hasMounted, // Only fetch after component mounts to avoid useInsertionEffect issues
  });

  // Static content - can be re-rolled via logo click
  const [splashContent, setSplashContent] = useState(() => ({
    obliqueStrategy: randomFrom(OBLIQUE_STRATEGIES),
    agencyPrompt: randomFrom(AGENCY_PROMPTS),
    contextualQuip: getContextualQuip(),
    explorePrompt: randomFrom(EXPLORE_PROMPTS),
  }));

  const greeting = useMemo(() => {
    const name = currentUser?.name?.split(' ')[0] || currentUser?.username || 'there';
    return `${getTimeOfDayGreeting()}, ${name}`;
  }, [currentUser]);

  // Handle card clicks - pre-fill the input
  // Defer state updates to avoid useInsertionEffect conflicts with MUI/React 19
  const handleCardClick = useCallback(
    (text: string) => {
      setTimeout(() => {
        setChatInputValue(text);
        // Focus the input after setting the value
        const input = document.querySelector('[data-testid="session-input"]') as HTMLTextAreaElement;
        input?.focus();
      }, 0);
    },
    [setChatInputValue]
  );

  // Magic 8-ball: Re-roll the prompts when logo is clicked
  const handleLogoClick = useCallback(() => {
    if (allSessions.length < 2) return;

    // Trigger shake animation
    setIsShaking(true);
    setTimeout(() => setIsShaking(false), 500);

    // Generate new prompts with a slight delay for visual effect
    setTimeout(() => {
      // Re-roll connect prompt
      const newPrompts = generateConnectTheDotsPrompts(allSessions, 1);
      if (newPrompts.length > 0) {
        setConnectPrompts(newPrompts);
      }

      // Re-roll single-notebook prompts
      const meaningfulSessions = allSessions.filter(s => s.name && s.name !== 'New Chat' && s.name.length > 3);
      if (meaningfulSessions.length > 0) {
        const shuffledForSingle = shuffleArray(meaningfulSessions);
        setSingleNotebookPrompts({
          remix: randomFrom(SINGLE_NOTEBOOK_REMIX_TEMPLATES)(shuffledForSingle[0].name),
          synthesis: randomFrom(SINGLE_NOTEBOOK_SYNTHESIS_TEMPLATES)(
            shuffledForSingle[Math.min(1, shuffledForSingle.length - 1)].name
          ),
        });
      }

      // Re-roll card types and oblique strategy
      setCardSlotTypes(pickCardSlots());
      setSplashContent(prev => ({
        ...prev,
        obliqueStrategy: randomFrom(OBLIQUE_STRATEGIES),
        agencyPrompt: randomFrom(AGENCY_PROMPTS),
        contextualQuip: getContextualQuip(),
        explorePrompt: randomFrom(EXPLORE_PROMPTS),
      }));
    }, 200);
  }, [allSessions]);

  // Use custom logo if available
  const customLogoUrl = useGetLogo();
  const logoSrc = customLogoUrl || '/images/logos/Colored_Favicon.svg';

  return (
    <Box
      sx={{
        height: '100%',
        width: '100%',
        maxWidth: '950px',
        margin: '0 auto',
        overflow: 'auto',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        py: { xs: 3, sm: 4 },
        px: { xs: 2, sm: 4 },
        gap: { xs: 3, sm: 3 },
      }}
    >
      {/* Header: Logo + Greeting */}
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: { xs: 1.5, sm: 2 },
          textAlign: 'center',
        }}
      >
        <Tooltip
          title="Shake for new connections"
          variant="soft"
          placement="top"
          disableHoverListener={allSessions.length < 2 || isMobile}
          disableFocusListener={allSessions.length < 2 || isMobile}
          disableTouchListener
        >
          <Box
            onClick={handleLogoClick}
            sx={{
              position: 'relative',
              width: isMobile ? '48px' : '64px',
              height: isMobile ? '48px' : '64px',
              flexShrink: 0,
              cursor: allSessions.length >= 2 ? 'pointer' : 'default',
              transition: 'transform 0.2s ease',
              animation: isShaking ? `${shakeAnimation} 0.5s ease-in-out` : 'none',
              '&:hover':
                allSessions.length >= 2
                  ? {
                      transform: 'scale(1.1)',
                    }
                  : {},
              '&:active':
                allSessions.length >= 2
                  ? {
                      transform: 'scale(0.95)',
                    }
                  : {},
            }}
          >
            {customLogoUrl ? (
              <img
                src={logoSrc}
                alt="Logo"
                loading="eager"
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'contain',
                }}
              />
            ) : (
              <NextImage src={logoSrc} alt={APP_NAME ? `${APP_NAME} Logo` : 'Logo'} priority fill />
            )}
          </Box>
        </Tooltip>

        <Box>
          <Typography
            level={isMobile ? 'h3' : 'h2'}
            sx={{
              color: 'text.primary',
              fontWeight: 500,
            }}
          >
            {greeting}
          </Typography>

          {/* Sky Greeting - Astronomy Info */}
          {skyGreeting && (
            <Box sx={{ mt: 1.5 }}>
              <Typography
                sx={{
                  color: 'text.primary',
                  fontSize: '13px',
                }}
              >
                {skyGreeting.moon.emoji} {skyGreeting.moon.phase} ({skyGreeting.moon.illumination}% illuminated)
                {skyGreeting.moon.daysToFullMoon <= 3 && (
                  <>
                    {' '}
                    &bull; {skyGreeting.moon.nextFullMoonName} in {Math.round(skyGreeting.moon.daysToFullMoon)} days
                  </>
                )}
              </Typography>
              <Typography
                sx={{
                  color: 'text.tertiary',
                  fontSize: '13px',
                  mt: 0.5,
                }}
              >
                {skyGreeting.planet}
              </Typography>
            </Box>
          )}
        </Box>
      </Box>

      {/* Prompt Cards */}
      {(() => {
        // Map each card slot type to its card definition
        const cardForSlot = (slot: CardSlotType): SplashCardProps => {
          switch (slot) {
            case 'connect':
              return connectPrompts[0]
                ? {
                    icon: '&#x1F517;',
                    title: 'Connect the dots',
                    description: connectPrompts[0].text,
                    onClick: () => handleCardClick(connectPrompts[0].text),
                  }
                : {
                    icon: '&#x1F3AF;',
                    title: 'Focus',
                    description: splashContent.agencyPrompt,
                    onClick: () => handleCardClick(splashContent.agencyPrompt),
                  };
            case 'remix':
              return singleNotebookPrompts.remix
                ? {
                    icon: '&#x1F500;',
                    title: 'Remix',
                    description: singleNotebookPrompts.remix,
                    onClick: () => handleCardClick(singleNotebookPrompts.remix!),
                  }
                : {
                    icon: '&#x2728;',
                    title: 'Right now',
                    description: splashContent.contextualQuip,
                    onClick: () => handleCardClick(splashContent.contextualQuip),
                  };
            case 'synthesis':
              return singleNotebookPrompts.synthesis
                ? {
                    icon: '&#x1F4A1;',
                    title: 'Synthesis',
                    description: singleNotebookPrompts.synthesis,
                    onClick: () => handleCardClick(singleNotebookPrompts.synthesis!),
                  }
                : {
                    icon: '&#x1F4A1;',
                    title: 'Explore',
                    description: splashContent.explorePrompt,
                    onClick: () => handleCardClick(splashContent.explorePrompt),
                  };
            case 'oblique':
              return {
                icon: '&#x1F3B2;',
                title: 'Oblique Strategy',
                description: splashContent.obliqueStrategy,
                onClick: () => handleCardClick(splashContent.obliqueStrategy),
                source: "Brian Eno's Oblique Strategies",
                sourceUrl: 'https://www.enoshop.co.uk/product/oblique-strategies.html',
              };
            case 'focus':
              return {
                icon: '&#x1F3AF;',
                title: 'Focus',
                description: splashContent.agencyPrompt,
                onClick: () => handleCardClick(splashContent.agencyPrompt),
              };
            case 'rightNow':
              return {
                icon: '&#x2728;',
                title: 'Right now',
                description: splashContent.contextualQuip,
                onClick: () => handleCardClick(splashContent.contextualQuip),
              };
          }
        };

        // Build 4 cards from the randomly selected slot types
        // Deduplicate fallback titles (e.g. if 'connect' falls back to 'Focus' and 'focus' is also selected)
        const seen = new Set<string>();
        const cards: SplashCardProps[] = [];
        for (const slot of cardSlotTypes) {
          const card = cardForSlot(slot);
          if (!seen.has(card.title)) {
            seen.add(card.title);
            cards.push(card);
          }
        }
        // If deduplication removed cards, fill remaining from unused standalone types
        if (cards.length < 4) {
          const fillers: SplashCardProps[] = [
            {
              icon: '&#x1F3AF;',
              title: 'Focus',
              description: splashContent.agencyPrompt,
              onClick: () => handleCardClick(splashContent.agencyPrompt),
            },
            {
              icon: '&#x2728;',
              title: 'Right now',
              description: splashContent.contextualQuip,
              onClick: () => handleCardClick(splashContent.contextualQuip),
            },
            {
              icon: '&#x1F4A1;',
              title: 'Explore',
              description: splashContent.explorePrompt,
              onClick: () => handleCardClick(splashContent.explorePrompt),
            },
          ];
          for (const filler of fillers) {
            if (cards.length >= 4) break;
            if (!seen.has(filler.title)) {
              seen.add(filler.title);
              cards.push(filler);
            }
          }
        }

        if (isMobile) {
          return <MobileSplashCarousel cards={cards} />;
        }

        return (
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, 1fr)',
              gap: 2,
              width: '100%',
            }}
          >
            {cards.map((card, i) => (
              <SplashCard key={i} {...card} />
            ))}
          </Box>
        );
      })()}
    </Box>
  );
};

export default NotebookSplash;
