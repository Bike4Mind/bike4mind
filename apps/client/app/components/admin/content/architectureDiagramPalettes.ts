/* Color palettes for ArchitectureDiagramsTab: the one place its literal colors live. The light values are the
 * original diagram colors; the dark ones keep each hue but swap the pale fills for deep ones, so the figure does
 * not glare in dark mode. architectureDiagramPalettes.test.ts pins the contrast of every text pair drawn. */
export const LIGHT_PALETTE = {
  // AWS services
  aws: '#FF9900',
  awsLight: '#FFF3E0',
  awsDark: '#E68A00',
  lambda: '#F59E0B',
  lambdaLight: '#FEF3C7',
  sqs: '#D946EF',
  sqsLight: '#FAE8FF',
  s3: '#3B82F6',
  s3Light: '#DBEAFE',
  apiGw: '#8B5CF6',
  apiGwLight: '#EDE9FE',
  ecs: '#F97316',
  ecsLight: '#FFF7ED',
  cloudfront: '#7C3AED',
  cloudfrontLight: '#F5F3FF',
  secrets: '#6366F1',
  secretsLight: '#EEF2FF',
  eventBridge: '#EC4899',
  eventBridgeLight: '#FCE7F3',

  // MongoDB
  mongo: '#00684A',
  mongoLight: '#E8F5E9',

  // Client / browser
  client: '#0EA5E9',
  clientLight: '#E0F2FE',

  // Security
  security: '#DC2626',
  securityLight: '#FEE2E2',
  securityMid: '#EF4444',

  // RAG / AI
  ai: '#8B5CF6',
  aiLight: '#EDE9FE',
  vector: '#06B6D4',
  vectorLight: '#CFFAFE',
  embed: '#14B8A6',
  embedLight: '#CCFBF1',

  // General
  text: '#1E293B',
  textLight: '#64748B',
  bg: '#F8FAFC',
  panel: '#FFFFFF',
  border: '#CBD5E1',
  arrow: '#94A3B8',
  arrowDark: '#475569',
  vpc: '#FEF9C3',
  vpcBorder: '#CA8A04',
  onAccent: '#FFFFFF',
  mongoSolid: '#00684A',
  mongoSolidBorder: '#004D35',
  shadow: '#000',

  // Security layers, outermost first
  securityLayers: [
    { fill: '#FEF2F2', stroke: '#991B1B' },
    { fill: '#FEE2E2', stroke: '#B91C1C' },
    { fill: '#FECACA', stroke: '#DC2626' },
    { fill: '#FCA5A5', stroke: '#EF4444' },
    { fill: '#F87171', stroke: '#DC2626' },
    { fill: '#EF4444', stroke: '#B91C1C' },
    { fill: '#DC2626', stroke: '#991B1B' },
    { fill: '#B91C1C', stroke: '#7F1D1D' },
  ],
};

export type DiagramPalette = typeof LIGHT_PALETTE;

export const DARK_PALETTE: DiagramPalette = {
  // AWS services
  aws: '#FFB547',
  awsLight: '#3A2A12',
  awsDark: '#FF9900',
  lambda: '#FBBF24',
  lambdaLight: '#33290F',
  sqs: '#E879F9',
  sqsLight: '#3A1A40',
  s3: '#60A5FA',
  s3Light: '#172A46',
  apiGw: '#A78BFA',
  apiGwLight: '#2A2145',
  ecs: '#FB923C',
  ecsLight: '#3A2412',
  cloudfront: '#C4B5FD',
  cloudfrontLight: '#261C42',
  secrets: '#A5B4FC',
  secretsLight: '#1F2247',
  eventBridge: '#F472B6',
  eventBridgeLight: '#3D1830',

  // MongoDB
  mongo: '#34D399',
  mongoLight: '#0F2E24',

  // Client / browser
  client: '#38BDF8',
  clientLight: '#0C2A3A',

  // Security
  security: '#F87171',
  securityLight: '#3A1717',
  securityMid: '#FCA5A5',

  // RAG / AI
  ai: '#A78BFA',
  aiLight: '#2A2145',
  vector: '#22D3EE',
  vectorLight: '#0B3038',
  embed: '#2DD4BF',
  embedLight: '#0B2F2B',

  // General
  text: '#E4E4E7',
  textLight: '#A1A1AA',
  bg: '#1A1A1E',
  panel: '#26262B',
  border: '#3F3F46',
  arrow: '#71717A',
  arrowDark: '#A1A1AA',
  vpc: '#2B2710',
  vpcBorder: '#EAB308',
  onAccent: '#FFFFFF',
  mongoSolid: '#047857',
  mongoSolidBorder: '#065F46',
  shadow: '#000',

  // Security layers, outermost first
  securityLayers: [
    { fill: '#2B1517', stroke: '#FCA5A5' },
    { fill: '#33181A', stroke: '#FCA5A5' },
    { fill: '#3D1A1C', stroke: '#FCA5A5' },
    { fill: '#491C1E', stroke: '#FECACA' },
    { fill: '#561D20', stroke: '#FECACA' },
    { fill: '#641E21', stroke: '#FECACA' },
    { fill: '#721E21', stroke: '#FEE2E2' },
    { fill: '#801D20', stroke: '#FEE2E2' },
  ],
};
