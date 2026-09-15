import { Modal, ModalClose, ModalDialog, Box, Typography, Card, Stack, Chip, Input, Button, Tooltip } from '@mui/joy';
import { FC, useState } from 'react';
import {
  green,
  blue,
  purple,
  orange,
  red,
  gray,
  cyan,
  pink,
  brand,
  greenAlpha,
  brandAlpha,
  purpleAlpha,
  orangeAlpha,
  redAlpha,
  grayAlpha,
  cyanAlpha,
  pinkAlpha,
  whiteAlpha,
  blackAlpha,
} from '../../utils/themes/colors';
import {
  TrendingUp,
  Search,
  Business,
  AttachMoney,
  Analytics,
  Article,
  SmartToy,
  ShowChart,
  Work,
  Handshake,
  AccountBalance,
  RocketLaunch,
  Newspaper,
} from '@mui/icons-material';
import earningsData from './data/earnings-targets.json';
import pressData from './data/press-targets.json';
import aiData from './data/ai-targets.json';
import jobsData from './data/jobs-targets.json';
import maData from './data/m_and_a-targets.json';
import secData from './data/sec-targets.json';
import productsData from './data/products-targets.json';
import newsData from './data/news-targets.json';

interface PopularTarget {
  company: string;
  ticker: string;
  url: string;
  category: 'tech' | 'finance' | 'healthcare' | 'energy';
}

interface DataSource {
  category: string;
  title: string;
  description: string;
  targets: PopularTarget[];
}

type DataSourceType = 'earnings' | 'press' | 'ai' | 'jobs' | 'ma' | 'sec' | 'products' | 'news';

const DATA_SOURCES: Record<DataSourceType, DataSource> = {
  earnings: earningsData as DataSource,
  press: pressData as DataSource,
  ai: aiData as DataSource,
  jobs: jobsData as DataSource,
  ma: maData as DataSource,
  sec: secData as DataSource,
  products: productsData as DataSource,
  news: newsData as DataSource,
};

const getCategoryIcon = (category: string) => {
  switch (category) {
    case 'tech':
      return <Analytics sx={{ fontSize: 16 }} />;
    case 'finance':
      return <AttachMoney sx={{ fontSize: 16 }} />;
    case 'healthcare':
      return <Business sx={{ fontSize: 16 }} />;
    default:
      return <TrendingUp sx={{ fontSize: 16 }} />;
  }
};

const getCategoryColor = (category: string) => {
  switch (category) {
    case 'tech':
      return 'primary';
    case 'finance':
      return 'success';
    case 'healthcare':
      return 'warning';
    default:
      return 'neutral';
  }
};

const getCardAccent = (sourceType: DataSourceType) => {
  switch (sourceType) {
    case 'earnings':
      return {
        borderTop: `3px solid ${green[400]}`,
        '&:hover': { borderTopColor: green[650] },
      };
    case 'press':
      return {
        borderTop: `3px solid ${brand[500]}`,
        '&:hover': { borderTopColor: blue[800] },
      };
    case 'ai':
      return {
        borderTop: `3px solid ${purple[500]}`,
        '&:hover': { borderTopColor: purple[700] },
      };
    case 'jobs':
      return {
        borderTop: `3px solid ${orange[550]}`,
        '&:hover': { borderTopColor: orange[650] },
      };
    case 'ma':
      return {
        borderTop: `3px solid ${red[400]}`,
        '&:hover': { borderTopColor: red[550] },
      };
    case 'sec':
      return {
        borderTop: `3px solid ${gray[690]}`,
        '&:hover': { borderTopColor: gray[720] },
      };
    case 'products':
      return {
        borderTop: `3px solid ${cyan[400]}`,
        '&:hover': { borderTopColor: cyan[500] },
      };
    case 'news':
      return {
        borderTop: `3px solid ${pink[400]}`,
        '&:hover': { borderTopColor: pink[500] },
      };
  }
};

interface PopularTargetsModalProps {
  open: boolean;
  onClose: () => void;
  onSelect: (url: string, company: string) => void;
}

const PopularTargetsModal: FC<PopularTargetsModalProps> = ({ open, onClose, onSelect }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [activeDataSource, setActiveDataSource] = useState<DataSourceType>('earnings');

  const currentDataSource = DATA_SOURCES[activeDataSource];

  const filteredTargets = currentDataSource.targets.filter(
    (target: PopularTarget) =>
      target.company.toLowerCase().includes(searchTerm.toLowerCase()) ||
      target.ticker.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const handleSelect = (target: PopularTarget) => {
    onSelect(target.url, target.company);
    onClose();
  };

  const getTabIcon = (type: DataSourceType) => {
    switch (type) {
      case 'earnings':
        return <ShowChart />;
      case 'press':
        return <Article />;
      case 'ai':
        return <SmartToy />;
      case 'jobs':
        return <Work />;
      case 'ma':
        return <Handshake />;
      case 'sec':
        return <AccountBalance />;
      case 'products':
        return <RocketLaunch />;
      case 'news':
        return <Newspaper />;
    }
  };

  const getTabGradient = (type: DataSourceType) => {
    switch (type) {
      case 'earnings':
        return `linear-gradient(135deg, ${green[400]} 0%, ${green[650]} 100%)`;
      case 'press':
        return `linear-gradient(135deg, ${brand[500]} 0%, ${blue[800]} 100%)`;
      case 'ai':
        return `linear-gradient(135deg, ${purple[500]} 0%, ${purple[700]} 100%)`;
      case 'jobs':
        return `linear-gradient(135deg, ${orange[550]} 0%, ${orange[650]} 100%)`;
      case 'ma':
        return `linear-gradient(135deg, ${red[400]} 0%, ${red[550]} 100%)`;
      case 'sec':
        return `linear-gradient(135deg, ${gray[690]} 0%, ${gray[720]} 100%)`;
      case 'products':
        return `linear-gradient(135deg, ${cyan[400]} 0%, ${cyan[500]} 100%)`;
      case 'news':
        return `linear-gradient(135deg, ${pink[400]} 0%, ${pink[500]} 100%)`;
    }
  };

  const getTabShadow = (type: DataSourceType) => {
    switch (type) {
      case 'earnings':
        return greenAlpha[400][40];
      case 'press':
        return brandAlpha[500][40];
      case 'ai':
        return purpleAlpha[500][40];
      case 'jobs':
        return orangeAlpha[550][40];
      case 'ma':
        return redAlpha[400][40];
      case 'sec':
        return grayAlpha[690][40];
      case 'products':
        return cyanAlpha[400][40];
      case 'news':
        return pinkAlpha[400][40];
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      sx={{
        position: 'fixed !important',
        inset: '0 !important',
        display: 'flex !important',
        justifyContent: 'center !important',
        alignItems: 'center !important',
        backdropFilter: 'blur(8px)',
        zIndex: 9999,
        m: '0 !important',
        p: '0 !important',
        '& .MuiModal-root': {
          position: 'fixed !important',
          inset: '0 !important',
        },
        '& > *': {
          position: 'relative !important',
        },
      }}
    >
      <ModalDialog
        sx={{
          position: 'fixed !important',
          top: '50% !important',
          left: '50% !important',
          transform: 'translate(-50%, -50%) !important',
          width: '90vw',
          height: '90vh',
          maxWidth: 'none',
          maxHeight: 'none',
          display: 'flex',
          flexDirection: 'column',
          background: `linear-gradient(135deg, ${whiteAlpha[0][98]} 0%, ${grayAlpha[15][95]} 50%, ${grayAlpha[5][98]} 100%)`,
          boxShadow: `0 25px 50px -12px ${blackAlpha[0][30]}, 0 0 0 1px ${whiteAlpha[0][5]}`,
          borderRadius: '20px',
          border: `1px solid ${whiteAlpha[0][30]}`,
          overflow: 'hidden',
          backdropFilter: 'blur(20px)',
          m: '0 !important',
          '&::before': {
            content: '""',
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: '4px',
            background: `linear-gradient(90deg, ${gray[780]} 0%, ${gray[750]} 25%, ${gray[680]} 50%, ${gray[750]} 75%, ${gray[780]} 100%)`,
            backgroundSize: '200% 100%',
            animation: 'corporate-shift 6s ease-in-out infinite',
          },
          '@keyframes corporate-shift': {
            '0%, 100%': {
              backgroundPosition: '0% 50%',
            },
            '50%': {
              backgroundPosition: '100% 50%',
            },
          },
        }}
      >
        <ModalClose
          sx={{
            position: 'absolute',
            top: 12,
            right: 12,
            zIndex: 10,
            borderRadius: '50%',
            transition: 'all 0.2s ease',
            '&:hover': {
              bgcolor: 'danger.softHoverBg',
              transform: 'scale(1.1)',
            },
          }}
        />

        <Box sx={{ p: 2, pb: 1 }}>
          {/* Header */}
          <Box sx={{ textAlign: 'center', mb: 2 }}>
            <Box
              sx={{
                display: 'flex',
                justifyContent: 'center',
                mb: 1.5,
                '& svg': {
                  fontSize: 40,
                  background: `linear-gradient(135deg, ${getTabGradient(activeDataSource).split('linear-gradient(135deg, ')[1]}`,
                  backgroundClip: 'text',
                  WebkitBackgroundClip: 'text',
                  color: 'transparent',
                  filter: `drop-shadow(0 4px 8px ${getTabShadow(activeDataSource)})`,
                  transition: 'all 0.5s ease',
                },
              }}
            >
              <TrendingUp />
            </Box>
            <Typography
              level="h4"
              sx={{
                background: `linear-gradient(135deg, ${getTabGradient(activeDataSource).split('linear-gradient(135deg, ')[1]}`,
                backgroundClip: 'text',
                WebkitBackgroundClip: 'text',
                color: 'transparent',
                fontWeight: 700,
                letterSpacing: '-0.025em',
                mb: 0.5,
                transition: 'all 0.5s ease',
              }}
            >
              {currentDataSource.title}
            </Typography>
            <Typography level="body-sm" color="neutral" sx={{ maxWidth: 600, mx: 'auto', fontWeight: 500 }}>
              {currentDataSource.description} • <strong>{filteredTargets.length} sources</strong> •{' '}
              <strong>
                {Object.values(DATA_SOURCES).reduce((total, source) => total + source.targets.length, 0)} total
              </strong>
            </Typography>
          </Box>

          {/* Data Source Tabs */}
          <Box sx={{ mb: 2, width: '100%' }}>
            <Stack
              direction="row"
              spacing={1}
              sx={{
                justifyContent: 'center',
                flexWrap: 'nowrap',
                gap: 1,
                overflowX: 'auto',
                py: 1,
                '&::-webkit-scrollbar': {
                  height: '4px',
                },
                '&::-webkit-scrollbar-thumb': {
                  background: blackAlpha[0][20],
                  borderRadius: '2px',
                },
              }}
            >
              {(['earnings', 'press', 'ai', 'jobs', 'ma', 'sec', 'products', 'news'] as DataSourceType[]).map(
                sourceType => (
                  <Button
                    key={sourceType}
                    variant={activeDataSource === sourceType ? 'solid' : 'outlined'}
                    color={activeDataSource === sourceType ? 'primary' : 'neutral'}
                    onClick={() => {
                      setActiveDataSource(sourceType);
                      setSearchTerm(''); // Clear search when switching
                    }}
                    startDecorator={getTabIcon(sourceType)}
                    sx={{
                      transition: 'all 0.3s ease',
                      borderRadius: '12px',
                      px: 2,
                      py: 1,
                      fontWeight: 600,
                      textTransform: 'none',
                      fontSize: '12px',
                      minWidth: 'auto',
                      whiteSpace: 'nowrap',
                      flexShrink: 0,
                      ...(activeDataSource === sourceType
                        ? {
                            background: getTabGradient(sourceType),
                            border: 'none',
                            color: 'white',
                            '& svg': { color: 'white' },
                          }
                        : {}),
                      '&:hover': {
                        transform: 'translateY(-2px)',
                        boxShadow:
                          activeDataSource === sourceType
                            ? `0 8px 20px ${getTabShadow(sourceType)}`
                            : `0 4px 12px ${blackAlpha[0][10]}`,
                      },
                      '&:active': {
                        transform: 'translateY(0px)',
                      },
                    }}
                  >
                    {DATA_SOURCES[sourceType].title}
                  </Button>
                )
              )}
            </Stack>
          </Box>

          {/* Search */}
          <Box sx={{ mb: 2, maxWidth: '600px', mx: 'auto' }}>
            <Input
              placeholder={`Search ${currentDataSource.title.toLowerCase()}...`}
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              startDecorator={<Search />}
              size="lg"
              sx={{
                '--Input-focusedThickness': '2px',
                '--Input-focusedHighlight': getTabShadow(activeDataSource),
                width: '100%',
                borderRadius: '12px',
                transition: 'all 0.3s ease',
                '&:focus-within': {
                  boxShadow: `0 0 0 2px ${getTabShadow(activeDataSource)}`,
                },
              }}
            />
          </Box>
        </Box>

        {/* Scrollable Content */}
        <Box
          sx={{
            flex: 1,
            overflowY: 'auto',
            px: 2,
            pb: 2,
            '&::-webkit-scrollbar': {
              width: '8px',
            },
            '&::-webkit-scrollbar-track': {
              background: 'transparent',
            },
            '&::-webkit-scrollbar-thumb': {
              background: blackAlpha[0][20],
              borderRadius: '4px',
            },
            '&::-webkit-scrollbar-thumb:hover': {
              background: blackAlpha[0][30],
            },
          }}
        >
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: {
                xs: 'repeat(3, 1fr)',
                sm: 'repeat(4, 1fr)',
                md: 'repeat(6, 1fr)',
                lg: 'repeat(8, 1fr)',
                xl: 'repeat(10, 1fr)',
              },
              gap: 2,
              alignItems: 'start',
            }}
          >
            {filteredTargets.map((target: PopularTarget, index: number) => (
              <Tooltip
                key={index}
                title={target.url}
                placement="top"
                arrow
                sx={{
                  '& .MuiTooltip-tooltip': {
                    fontFamily: 'monospace',
                    fontSize: '11px',
                    maxWidth: '400px',
                    wordBreak: 'break-all',
                  },
                }}
              >
                <Card
                  variant="outlined"
                  sx={{
                    cursor: 'pointer',
                    transition: 'all 0.3s ease',
                    border: '1px solid',
                    borderColor: 'divider',
                    p: 2,
                    minHeight: '112px',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'center',
                    alignItems: 'center',
                    textAlign: 'center',
                    background: `linear-gradient(135deg, ${whiteAlpha[0][90]} 0%, ${grayAlpha[15][90]} 100%)`,
                    ...getCardAccent(activeDataSource),
                    '&:hover': {
                      borderColor: 'primary.400',
                      boxShadow: `0 8px 25px ${getTabShadow(activeDataSource)}`,
                      transform: 'translateY(-4px)',
                      background: `linear-gradient(135deg, ${gray[0]} 0%, ${gray[15]} 100%)`,
                    },
                    '&:active': {
                      transform: 'translateY(-2px)',
                    },
                  }}
                  onClick={() => handleSelect(target)}
                >
                  <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.75 }}>
                    <Box sx={{ '& svg': { fontSize: '20px' } }}>{getCategoryIcon(target.category)}</Box>
                    <Typography level="body-sm" fontWeight={600} sx={{ fontSize: '15px', lineHeight: 1.2 }}>
                      {target.company}
                    </Typography>
                    <Chip
                      size="sm"
                      color={getCategoryColor(target.category) as any}
                      variant="soft"
                      sx={{
                        fontWeight: 600,
                        fontSize: '13px',
                        minHeight: '24px',
                        px: 1,
                      }}
                    >
                      {target.ticker}
                    </Chip>
                  </Box>
                </Card>
              </Tooltip>
            ))}
          </Box>

          {filteredTargets.length === 0 && (
            <Box sx={{ textAlign: 'center', py: 4 }}>
              <Typography level="body-sm" color="neutral">
                No companies found matching &ldquo;{searchTerm}&rdquo;
              </Typography>
            </Box>
          )}
        </Box>
      </ModalDialog>
    </Modal>
  );
};

export default PopularTargetsModal;
