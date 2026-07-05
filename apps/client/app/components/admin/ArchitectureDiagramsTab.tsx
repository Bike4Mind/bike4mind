import { Box, Tab, TabList, TabPanel, Tabs, useTheme } from '@mui/joy';
import React, { useState } from 'react';

/* Color palette */
const C = {
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
  white: '#FFFFFF',
  border: '#CBD5E1',
  arrow: '#94A3B8',
  arrowDark: '#475569',
  vpc: '#FEF9C3',
  vpcBorder: '#CA8A04',
};

/* Shared SVG defs */
const SvgDefs: React.FC = () => (
  <defs>
    <marker
      id="arrowEnd"
      viewBox="0 0 10 10"
      refX="9"
      refY="5"
      markerWidth="8"
      markerHeight="8"
      orient="auto-start-reverse"
    >
      <path d="M 0 0 L 10 5 L 0 10 z" fill={C.arrowDark} />
    </marker>
    <marker
      id="arrowEndLight"
      viewBox="0 0 10 10"
      refX="9"
      refY="5"
      markerWidth="7"
      markerHeight="7"
      orient="auto-start-reverse"
    >
      <path d="M 0 0 L 10 5 L 0 10 z" fill={C.arrow} />
    </marker>
    <filter id="shadow" x="-4%" y="-4%" width="108%" height="116%">
      <feDropShadow dx="0" dy="2" stdDeviation="3" floodColor="#000" floodOpacity="0.08" />
    </filter>
    <filter id="shadowLg" x="-4%" y="-4%" width="108%" height="116%">
      <feDropShadow dx="0" dy="4" stdDeviation="6" floodColor="#000" floodOpacity="0.12" />
    </filter>
  </defs>
);

/* Reusable primitives */
interface ServiceBoxProps {
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
  stroke: string;
  label: string;
  sublabel?: string;
  icon?: string;
  fontSize?: number;
}

const ServiceBox: React.FC<ServiceBoxProps> = ({ x, y, w, h, fill, stroke, label, sublabel, icon, fontSize = 13 }) => (
  <g filter="url(#shadow)">
    <rect x={x} y={y} width={w} height={h} rx={10} ry={10} fill={fill} stroke={stroke} strokeWidth={1.5} />
    {icon && (
      <text
        x={x + 12}
        y={y + h / 2 + (sublabel ? -4 : 5)}
        fontFamily="Urbanist, sans-serif"
        fontSize={16}
        fill={stroke}
      >
        {icon}
      </text>
    )}
    <text
      x={x + (icon ? 32 : w / 2)}
      y={y + (sublabel ? h / 2 - 4 : h / 2 + 5)}
      fontFamily="Urbanist, sans-serif"
      fontSize={fontSize}
      fontWeight="600"
      fill={C.text}
      textAnchor={icon ? 'start' : 'middle'}
    >
      {label}
    </text>
    {sublabel && (
      <text
        x={x + (icon ? 32 : w / 2)}
        y={y + h / 2 + 14}
        fontFamily="Urbanist, sans-serif"
        fontSize={11}
        fill={C.textLight}
        textAnchor={icon ? 'start' : 'middle'}
      >
        {sublabel}
      </text>
    )}
  </g>
);

const Arrow: React.FC<{ x1: number; y1: number; x2: number; y2: number; label?: string; dashed?: boolean }> = ({
  x1,
  y1,
  x2,
  y2,
  label,
  dashed,
}) => (
  <g>
    <line
      x1={x1}
      y1={y1}
      x2={x2}
      y2={y2}
      stroke={C.arrowDark}
      strokeWidth={1.5}
      markerEnd="url(#arrowEnd)"
      strokeDasharray={dashed ? '6 4' : undefined}
    />
    {label && (
      <text
        x={(x1 + x2) / 2}
        y={(y1 + y2) / 2 - 6}
        fontFamily="Urbanist, sans-serif"
        fontSize={10}
        fill={C.textLight}
        textAnchor="middle"
      >
        {label}
      </text>
    )}
  </g>
);

/* Diagram 1: User Prompt Journey */
const UserPromptJourney: React.FC = () => (
  <svg viewBox="0 0 1100 800" width="100%" height="100%" style={{ fontFamily: 'Urbanist, sans-serif' }}>
    <SvgDefs />
    <rect width={1100} height={800} fill={C.bg} rx={12} />

    <text
      x={550}
      y={36}
      fontFamily="Urbanist, sans-serif"
      fontSize={20}
      fontWeight="700"
      fill={C.text}
      textAnchor="middle"
    >
      User Prompt Journey &mdash; Keystroke to AI Response
    </text>

    {/* Browser */}
    <ServiceBox
      x={380}
      y={55}
      w={340}
      h={56}
      fill={C.clientLight}
      stroke={C.client}
      label="Browser"
      sublabel="Next.js 16 + React 19 + MUI Joy + Zustand"
      icon="&#x1F310;"
    />
    <Arrow x1={550} y1={111} x2={550} y2={138} label="TLS 1.3" />

    {/* CloudFront */}
    <ServiceBox
      x={340}
      y={140}
      w={420}
      h={50}
      fill={C.cloudfrontLight}
      stroke={C.cloudfront}
      label="CloudFront CDN"
      sublabel="Edge Caching, SSL Termination, DDoS Protection"
      icon="&#x26A1;"
    />
    <Arrow x1={550} y1={190} x2={550} y2={218} />

    {/* Auth Layer */}
    <g filter="url(#shadowLg)">
      <rect x={240} y={220} width={620} height={78} rx={10} fill={C.apiGwLight} stroke={C.apiGw} strokeWidth={1.5} />
      <text
        x={550}
        y={244}
        fontFamily="Urbanist, sans-serif"
        fontSize={14}
        fontWeight="700"
        fill={C.apiGw}
        textAnchor="middle"
      >
        API Gateway + Auth Layer
      </text>
      <g fontFamily="Urbanist, sans-serif" fontSize={11} fill={C.text}>
        <text x={270} y={272}>
          1. API Key Auth
        </text>
        <text x={400} y={272}>
          2. JWT + MFA
        </text>
        <text x={530} y={272}>
          3. CASL Permission
        </text>
        <text x={680} y={272}>
          4. Rate Limit
        </text>
        <text x={270} y={290}>
          5. Idempotency
        </text>
      </g>
    </g>
    <Arrow x1={550} y1={298} x2={550} y2={326} label="Enqueue" />

    {/* SQS */}
    <ServiceBox
      x={400}
      y={328}
      w={300}
      h={46}
      fill={C.sqsLight}
      stroke={C.sqs}
      label="SQS: questStartQueue + DLQ"
      icon="&#x1F4E8;"
    />
    <Arrow x1={550} y1={374} x2={550} y2={402} />

    {/* VPC + Lambda */}
    <g>
      <rect
        x={120}
        y={400}
        width={860}
        height={260}
        rx={12}
        fill={C.vpc}
        stroke={C.vpcBorder}
        strokeWidth={1.5}
        strokeDasharray="8 4"
      />
      <text x={140} y={422} fontFamily="Urbanist, sans-serif" fontSize={11} fontWeight="600" fill={C.vpcBorder}>
        VPC &mdash; Private Subnets
      </text>

      <g filter="url(#shadowLg)">
        <rect
          x={180}
          y={434}
          width={740}
          height={210}
          rx={10}
          fill={C.lambdaLight}
          stroke={C.lambda}
          strokeWidth={1.5}
        />
        <text
          x={550}
          y={460}
          fontFamily="Urbanist, sans-serif"
          fontSize={15}
          fontWeight="700"
          fill={C.text}
          textAnchor="middle"
        >
          Lambda: Quest Handler (Node.js 22.x, 15 min timeout, 2 GB)
        </text>

        {/* Phases */}
        <g fontFamily="Urbanist, sans-serif" fontSize={12} fill={C.text}>
          <rect x={210} y={474} width={320} height={28} rx={6} fill={C.white} stroke={C.border} strokeWidth={1} />
          <text x={220} y={493} fontWeight="600">
            Phase 1:
          </text>
          <text x={285} y={493}>
            Fetch session + user + API keys
          </text>

          <rect x={210} y={508} width={320} height={28} rx={6} fill={C.white} stroke={C.border} strokeWidth={1} />
          <text x={220} y={527} fontWeight="600">
            Phase 2:
          </text>
          <text x={285} y={527}>
            RAG search (cosine similarity)
          </text>

          <rect x={210} y={542} width={320} height={28} rx={6} fill={C.white} stroke={C.border} strokeWidth={1} />
          <text x={220} y={561} fontWeight="600">
            Phase 3:
          </text>
          <text x={285} y={561}>
            Build messages + system prompts
          </text>

          <rect x={560} y={474} width={340} height={28} rx={6} fill={C.white} stroke={C.border} strokeWidth={1} />
          <text x={570} y={493} fontWeight="600">
            Phase 4:
          </text>
          <text x={635} y={493}>
            Register 48+ tools (perm-gated)
          </text>

          <rect x={560} y={508} width={340} height={28} rx={6} fill={C.white} stroke={C.border} strokeWidth={1} />
          <text x={570} y={527} fontWeight="600">
            Phase 5:
          </text>
          <text x={635} y={527}>
            LLM Agentic Loop (tool calls)
          </text>

          <rect x={560} y={542} width={340} height={28} rx={6} fill={C.white} stroke={C.border} strokeWidth={1} />
          <text x={570} y={561} fontWeight="600">
            Phase 6:
          </text>
          <text x={635} y={561}>
            Stream response via WebSocket
          </text>
        </g>
      </g>
    </g>

    {/* Bottom: Data Sources + External */}
    <Arrow x1={370} y1={660} x2={370} y2={695} />
    <Arrow x1={730} y1={660} x2={730} y2={695} />

    <g filter="url(#shadow)">
      <rect x={160} y={697} width={420} height={55} rx={10} fill={C.mongoLight} stroke={C.mongo} strokeWidth={1.5} />
      <text
        x={370}
        y={720}
        fontFamily="Urbanist, sans-serif"
        fontSize={13}
        fontWeight="600"
        fill={C.text}
        textAnchor="middle"
      >
        Data Sources
      </text>
      <text x={370} y={740} fontFamily="Urbanist, sans-serif" fontSize={11} fill={C.textLight} textAnchor="middle">
        MongoDB Atlas &bull; S3 Buckets &bull; Vector Store
      </text>
    </g>

    <g filter="url(#shadow)">
      <rect x={620} y={697} width={360} height={55} rx={10} fill={C.aiLight} stroke={C.ai} strokeWidth={1.5} />
      <text
        x={800}
        y={720}
        fontFamily="Urbanist, sans-serif"
        fontSize={13}
        fontWeight="600"
        fill={C.text}
        textAnchor="middle"
      >
        External LLM Providers
      </text>
      <text x={800} y={740} fontFamily="Urbanist, sans-serif" fontSize={11} fill={C.textLight} textAnchor="middle">
        OpenAI &bull; Anthropic &bull; Bedrock &bull; Gemini
      </text>
    </g>
  </svg>
);

/* Diagram 2: Infrastructure Overview */
const InfrastructureOverview: React.FC = () => (
  <svg viewBox="0 0 1100 800" width="100%" height="100%" style={{ fontFamily: 'Urbanist, sans-serif' }}>
    <SvgDefs />
    <rect width={1100} height={800} fill={C.bg} rx={12} />

    <text
      x={550}
      y={36}
      fontFamily="Urbanist, sans-serif"
      fontSize={20}
      fontWeight="700"
      fill={C.text}
      textAnchor="middle"
    >
      Infrastructure Overview &mdash; AWS + MongoDB Atlas
    </text>

    {/* CloudFront */}
    <ServiceBox
      x={420}
      y={55}
      w={260}
      h={50}
      fill={C.cloudfrontLight}
      stroke={C.cloudfront}
      label="CloudFront CDN"
      icon="&#x1F30D;"
    />
    <Arrow x1={550} y1={105} x2={550} y2={140} />

    {/* API Gateway */}
    <ServiceBox
      x={370}
      y={142}
      w={360}
      h={50}
      fill={C.apiGwLight}
      stroke={C.apiGw}
      label="API Gateway"
      sublabel="REST + WebSocket"
      icon="&#x1F6E1;"
    />
    <Arrow x1={550} y1={192} x2={550} y2={230} />

    {/* Lambda cluster */}
    <g filter="url(#shadowLg)">
      <rect x={320} y={232} width={460} height={70} rx={10} fill={C.lambdaLight} stroke={C.lambda} strokeWidth={1.5} />
      <text
        x={550}
        y={260}
        fontFamily="Urbanist, sans-serif"
        fontSize={15}
        fontWeight="700"
        fill={C.text}
        textAnchor="middle"
      >
        Lambda Functions (44+)
      </text>
      <text x={550} y={280} fontFamily="Urbanist, sans-serif" fontSize={11} fill={C.textLight} textAnchor="middle">
        Quest Handlers &bull; API Routes &bull; Cron Jobs &bull; Queue Processors
      </text>
    </g>

    {/* SQS */}
    <Arrow x1={320} y1={267} x2={165} y2={340} />
    <ServiceBox
      x={40}
      y={340}
      w={250}
      h={56}
      fill={C.sqsLight}
      stroke={C.sqs}
      label="SQS Queues (18 + DLQs)"
      sublabel="questStart, fileIngest, equity..."
      icon="&#x1F4E8;"
    />

    {/* EventBridge */}
    <Arrow x1={165} y1={396} x2={165} y2={440} />
    <ServiceBox
      x={40}
      y={440}
      w={250}
      h={50}
      fill={C.eventBridgeLight}
      stroke={C.eventBridge}
      label="EventBridge"
      sublabel="Scheduled rules, event routing"
      icon="&#x23F0;"
    />

    {/* S3 */}
    <Arrow x1={780} y1={267} x2={910} y2={340} />
    <ServiceBox
      x={790}
      y={340}
      w={260}
      h={56}
      fill={C.s3Light}
      stroke={C.s3}
      label="S3 (6 Buckets)"
      sublabel="uploads, assets, exports, vectors..."
      icon="&#x1F4E6;"
    />

    {/* Secrets Manager */}
    <Arrow x1={910} y1={396} x2={910} y2={440} />
    <ServiceBox
      x={790}
      y={440}
      w={260}
      h={50}
      fill={C.secretsLight}
      stroke={C.secrets}
      label="Secrets Manager (43)"
      sublabel="API keys, credentials, config"
      icon="&#x1F511;"
    />

    {/* MongoDB */}
    <Arrow x1={550} y1={302} x2={550} y2={370} />
    <g filter="url(#shadowLg)">
      <rect x={370} y={370} width={360} height={70} rx={10} fill={C.mongoLight} stroke={C.mongo} strokeWidth={1.5} />
      <text
        x={550}
        y={398}
        fontFamily="Urbanist, sans-serif"
        fontSize={15}
        fontWeight="700"
        fill={C.mongo}
        textAnchor="middle"
      >
        MongoDB Atlas
      </text>
      <text x={550} y={418} fontFamily="Urbanist, sans-serif" fontSize={11} fill={C.textLight} textAnchor="middle">
        Users &bull; Sessions &bull; Files &bull; Vectors &bull; Organizations
      </text>
    </g>

    {/* Divider */}
    <line x1={100} y1={520} x2={1000} y2={520} stroke={C.border} strokeWidth={1} strokeDasharray="6 4" />
    <text
      x={550}
      y={545}
      fontFamily="Urbanist, sans-serif"
      fontSize={12}
      fontWeight="600"
      fill={C.textLight}
      textAnchor="middle"
    >
      Real-Time Layer
    </text>

    {/* ECS Fargate */}
    <g filter="url(#shadowLg)">
      <rect x={300} y={565} width={500} height={80} rx={10} fill={C.ecsLight} stroke={C.ecs} strokeWidth={1.5} />
      <text
        x={550}
        y={592}
        fontFamily="Urbanist, sans-serif"
        fontSize={15}
        fontWeight="700"
        fill={C.text}
        textAnchor="middle"
      >
        ECS Fargate: Subscriber-Fanout
      </text>
      <text x={550} y={614} fontFamily="Urbanist, sans-serif" fontSize={11} fill={C.textLight} textAnchor="middle">
        Long-running container &bull; Persistent WebSocket connections &bull; Multi-AZ
      </text>
    </g>

    {/* Change Streams + WS Push */}
    <Arrow x1={420} y1={645} x2={420} y2={700} label="Change Streams" />
    <ServiceBox
      x={300}
      y={702}
      w={240}
      h={46}
      fill={C.mongoLight}
      stroke={C.mongo}
      label="MongoDB Change Streams"
      fontSize={12}
    />

    <Arrow x1={680} y1={645} x2={680} y2={700} label="Push" />
    <ServiceBox
      x={580}
      y={702}
      w={200}
      h={46}
      fill={C.clientLight}
      stroke={C.client}
      label="WebSocket Clients"
      fontSize={12}
    />
  </svg>
);

/* Diagram 3: RAG Pipeline */
const RagPipeline: React.FC = () => {
  const boxW = 140;
  const boxH = 60;
  const gap = 10;
  const startX = 30;
  const y1 = 200;
  const y2 = 440;

  const stages = [
    { label: 'File Upload', sub: 'Browser / API', fill: C.clientLight, stroke: C.client },
    { label: 'S3 Storage', sub: 'Raw files', fill: C.s3Light, stroke: C.s3 },
    { label: 'SmartChunker', sub: 'Type-aware splitting', fill: C.lambdaLight, stroke: C.lambda },
    { label: 'Embedding', sub: 'OpenAI / Voyage / Bedrock', fill: C.embedLight, stroke: C.embed },
    { label: 'Vector Store', sub: 'MongoDB Atlas', fill: C.vectorLight, stroke: C.vector },
    { label: 'Cosine Search', sub: 'Similarity matching', fill: C.vectorLight, stroke: C.vector },
    { label: 'ReRank', sub: 'Relevance scoring', fill: C.aiLight, stroke: C.ai },
  ];

  const stages2 = [
    { label: 'Context Inject', sub: 'System prompt assembly', fill: C.aiLight, stroke: C.ai },
    { label: 'LLM Response', sub: 'Grounded generation', fill: C.aiLight, stroke: C.ai },
  ];

  return (
    <svg viewBox="0 0 1100 800" width="100%" height="100%" style={{ fontFamily: 'Urbanist, sans-serif' }}>
      <SvgDefs />
      <rect width={1100} height={800} fill={C.bg} rx={12} />

      <text
        x={550}
        y={36}
        fontFamily="Urbanist, sans-serif"
        fontSize={20}
        fontWeight="700"
        fill={C.text}
        textAnchor="middle"
      >
        RAG Pipeline &mdash; File Upload to Grounded AI Response
      </text>

      {/* Ingestion label */}
      <text
        x={550}
        y={170}
        fontFamily="Urbanist, sans-serif"
        fontSize={14}
        fontWeight="600"
        fill={C.textLight}
        textAnchor="middle"
      >
        Ingestion &amp; Indexing
      </text>

      {/* Row 1: Ingestion */}
      {stages.map((s, i) => {
        const x = startX + i * (boxW + gap);
        return (
          <g key={s.label}>
            <ServiceBox
              x={x}
              y={y1}
              w={boxW}
              h={boxH}
              fill={s.fill}
              stroke={s.stroke}
              label={s.label}
              sublabel={s.sub}
              fontSize={12}
            />
            {i < stages.length - 1 && <Arrow x1={x + boxW} y1={y1 + boxH / 2} x2={x + boxW + gap} y2={y1 + boxH / 2} />}
          </g>
        );
      })}

      {/* Bend down from ReRank */}
      {(() => {
        const lastX = startX + 6 * (boxW + gap) + boxW / 2;
        return (
          <g>
            <line x1={lastX} y1={y1 + boxH} x2={lastX} y2={y1 + boxH + 50} stroke={C.arrowDark} strokeWidth={1.5} />
            <line
              x1={lastX}
              y1={y1 + boxH + 50}
              x2={startX + boxW / 2}
              y2={y1 + boxH + 50}
              stroke={C.arrowDark}
              strokeWidth={1.5}
            />
            <line
              x1={startX + boxW / 2}
              y1={y1 + boxH + 50}
              x2={startX + boxW / 2}
              y2={y2}
              stroke={C.arrowDark}
              strokeWidth={1.5}
              markerEnd="url(#arrowEnd)"
            />
          </g>
        );
      })()}

      {/* Retrieval label */}
      <text
        x={550}
        y={y2 - 20}
        fontFamily="Urbanist, sans-serif"
        fontSize={14}
        fontWeight="600"
        fill={C.textLight}
        textAnchor="middle"
      >
        Query-Time Retrieval &amp; Generation
      </text>

      {/* Row 2: Context + LLM */}
      {stages2.map((s, i) => {
        const x = startX + i * (boxW + gap);
        return (
          <g key={s.label}>
            <ServiceBox
              x={x}
              y={y2}
              w={boxW}
              h={boxH}
              fill={s.fill}
              stroke={s.stroke}
              label={s.label}
              sublabel={s.sub}
              fontSize={12}
            />
            {i < stages2.length - 1 && (
              <Arrow x1={x + boxW} y1={y2 + boxH / 2} x2={x + boxW + gap} y2={y2 + boxH / 2} />
            )}
          </g>
        );
      })}

      {/* Detail boxes */}
      <g filter="url(#shadow)">
        <rect x={60} y={560} width={460} height={190} rx={10} fill={C.white} stroke={C.border} strokeWidth={1} />
        <text x={80} y={586} fontFamily="Urbanist, sans-serif" fontSize={14} fontWeight="700" fill={C.text}>
          SmartChunker Strategies
        </text>
        <g fontFamily="Urbanist, sans-serif" fontSize={12} fill={C.text}>
          <text x={80} y={612}>
            &bull; CSV: Row-aware chunking (preserves headers per chunk)
          </text>
          <text x={80} y={632}>
            &bull; PDF: Page-boundary splitting with overlap
          </text>
          <text x={80} y={652}>
            &bull; JSON: Schema-aware object splitting
          </text>
          <text x={80} y={672}>
            &bull; TXT/MD: Paragraph + heading-aware segmentation
          </text>
          <text x={80} y={692}>
            &bull; Code: AST-aware function/class boundaries
          </text>
          <text x={80} y={712}>
            &bull; Configurable chunk size + overlap parameters
          </text>
          <text x={80} y={732}>
            &bull; Metadata extraction (title, author, dates)
          </text>
        </g>
      </g>

      <g filter="url(#shadow)">
        <rect x={560} y={560} width={480} height={190} rx={10} fill={C.white} stroke={C.border} strokeWidth={1} />
        <text x={580} y={586} fontFamily="Urbanist, sans-serif" fontSize={14} fontWeight="700" fill={C.text}>
          Embedding Models
        </text>
        <g fontFamily="Urbanist, sans-serif" fontSize={12} fill={C.text}>
          <text x={580} y={612}>
            &bull; OpenAI text-embedding-3-small / 3-large
          </text>
          <text x={580} y={632}>
            &bull; Voyage AI voyage-3 / voyage-code-3
          </text>
          <text x={580} y={652}>
            &bull; AWS Bedrock Titan Embed v2
          </text>
          <text x={580} y={672}>
            &bull; Stored in MongoDB Atlas with vector indexes
          </text>
          <text x={580} y={692}>
            &bull; Cosine similarity search with configurable top-K
          </text>
          <text x={580} y={712}>
            &bull; Cross-encoder reranking for precision
          </text>
          <text x={580} y={732}>
            &bull; Source citations injected into LLM context
          </text>
        </g>
      </g>
    </svg>
  );
};

/* Diagram 4: Security Architecture */
const SecurityArchitecture: React.FC = () => {
  const layers = [
    {
      label: 'Network Layer',
      sub: 'VPC, Private Subnets, Security Groups, NAT Gateway',
      fill: '#FEF2F2',
      stroke: '#991B1B',
      y: 70,
      w: 960,
      h: 60,
    },
    {
      label: 'Transport Layer',
      sub: 'TLS 1.3 everywhere: Browser ↔ CloudFront ↔ API GW ↔ Lambda ↔ MongoDB',
      fill: '#FEE2E2',
      stroke: '#B91C1C',
      y: 145,
      w: 880,
      h: 60,
    },
    {
      label: 'Authentication (8 Methods)',
      sub: 'Email/Password + MFA TOTP, Magic Link, OAuth (Google/GitHub/Apple), API Key, Service Token, Device Auth',
      fill: '#FECACA',
      stroke: '#DC2626',
      y: 220,
      w: 800,
      h: 60,
    },
    {
      label: 'Authorization',
      sub: 'CASL ability-based access control, Role scopes (admin/analyst/user), Org-level permissions',
      fill: '#FCA5A5',
      stroke: '#EF4444',
      y: 295,
      w: 720,
      h: 60,
    },
    {
      label: 'Input Validation',
      sub: 'Zod schemas on every endpoint, Request sanitization, Content-type enforcement',
      fill: '#F87171',
      stroke: '#DC2626',
      y: 370,
      w: 640,
      h: 60,
    },
    {
      label: 'Secrets Management',
      sub: 'AWS Secrets Manager (43 secrets), AES-256-GCM token encryption at rest, Key rotation',
      fill: '#EF4444',
      stroke: '#B91C1C',
      y: 445,
      w: 560,
      h: 60,
    },
    {
      label: 'Rate Limiting',
      sub: 'Per-user throttle, API key quotas, DDoS protection (CloudFront + WAF)',
      fill: '#DC2626',
      stroke: '#991B1B',
      y: 520,
      w: 480,
      h: 60,
    },
    {
      label: 'Audit &amp; Monitoring',
      sub: 'Login records, API usage tracking, DLQ alerting, CloudWatch alarms',
      fill: '#B91C1C',
      stroke: '#7F1D1D',
      y: 595,
      w: 400,
      h: 60,
    },
  ];

  return (
    <svg viewBox="0 0 1100 800" width="100%" height="100%" style={{ fontFamily: 'Urbanist, sans-serif' }}>
      <SvgDefs />
      <rect width={1100} height={800} fill={C.bg} rx={12} />

      <text
        x={550}
        y={40}
        fontFamily="Urbanist, sans-serif"
        fontSize={20}
        fontWeight="700"
        fill={C.text}
        textAnchor="middle"
      >
        Security Architecture &mdash; Defense in Depth
      </text>

      {/* Concentric layers (centered) */}
      {layers.map(l => {
        const x = (1100 - l.w) / 2;
        return (
          <g key={l.label} filter="url(#shadow)">
            <rect x={x} y={l.y} width={l.w} height={l.h} rx={10} fill={l.fill} stroke={l.stroke} strokeWidth={1.5} />
            <text
              x={550}
              y={l.y + 24}
              fontFamily="Urbanist, sans-serif"
              fontSize={14}
              fontWeight="700"
              fill={l.stroke}
              textAnchor="middle"
            >
              {l.label}
            </text>
            <text
              x={550}
              y={l.y + 44}
              fontFamily="Urbanist, sans-serif"
              fontSize={11}
              fill={C.text}
              textAnchor="middle"
            >
              {l.sub}
            </text>
          </g>
        );
      })}

      {/* Core asset */}
      <g filter="url(#shadowLg)">
        <rect x={430} y={680} width={240} height={50} rx={25} fill={C.mongo} stroke="#004D35" strokeWidth={2} />
        <text
          x={550}
          y={710}
          fontFamily="Urbanist, sans-serif"
          fontSize={14}
          fontWeight="700"
          fill={C.white}
          textAnchor="middle"
        >
          User Data &amp; AI Sessions
        </text>
      </g>

      {/* Left sidebar: legend */}
      <g>
        <text x={40} y={720} fontFamily="Urbanist, sans-serif" fontSize={11} fontWeight="600" fill={C.textLight}>
          Outer = broader surface
        </text>
        <text x={40} y={738} fontFamily="Urbanist, sans-serif" fontSize={11} fontWeight="600" fill={C.textLight}>
          Inner = most sensitive
        </text>
        <line x1={40} y1={748} x2={160} y2={748} stroke={C.border} strokeWidth={1} />
        <text x={40} y={766} fontFamily="Urbanist, sans-serif" fontSize={10} fill={C.textLight}>
          8 layers of defense
        </text>
      </g>

      {/* Right sidebar: stats */}
      <g>
        <text x={900} y={700} fontFamily="Urbanist, sans-serif" fontSize={11} fontWeight="600" fill={C.textLight}>
          43 secrets managed
        </text>
        <text x={900} y={718} fontFamily="Urbanist, sans-serif" fontSize={11} fontWeight="600" fill={C.textLight}>
          AES-256-GCM at rest
        </text>
        <text x={900} y={736} fontFamily="Urbanist, sans-serif" fontSize={11} fontWeight="600" fill={C.textLight}>
          MFA/TOTP enforced
        </text>
        <text x={900} y={754} fontFamily="Urbanist, sans-serif" fontSize={11} fontWeight="600" fill={C.textLight}>
          CASL role-based access
        </text>
        <text x={900} y={772} fontFamily="Urbanist, sans-serif" fontSize={11} fontWeight="600" fill={C.textLight}>
          Zod on every endpoint
        </text>
      </g>
    </svg>
  );
};

/* Main component */
type DiagramTab = 'prompt' | 'infra' | 'rag' | 'security';

const ArchitectureDiagramsTab: React.FC = () => {
  const [activeTab, setActiveTab] = useState<DiagramTab>('prompt');
  const theme = useTheme();
  const mode = theme.palette.mode;

  return (
    <Box
      sx={{
        width: '100%',
        height: '100%',
        minHeight: '600px',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Tabs
        value={activeTab}
        onChange={(_, value) => setActiveTab(value as DiagramTab)}
        sx={{ flex: 1, display: 'flex', flexDirection: 'column' }}
      >
        <TabList
          sx={{
            mb: 2,
            borderRadius: 'sm',
            [`& .MuiTab-root`]: {
              fontWeight: 'md',
              textTransform: 'none',
              fontSize: '0.875rem',
            },
          }}
        >
          <Tab value="prompt" data-testid="arch-diagram-prompt-tab">
            User Prompt Journey
          </Tab>
          <Tab value="infra" data-testid="arch-diagram-infra-tab">
            Infrastructure Overview
          </Tab>
          <Tab value="rag" data-testid="arch-diagram-rag-tab">
            RAG Pipeline
          </Tab>
          <Tab value="security" data-testid="arch-diagram-security-tab">
            Security Architecture
          </Tab>
        </TabList>

        <TabPanel
          value="prompt"
          sx={{
            p: 0,
            flex: 1,
            overflow: 'auto',
            bgcolor: mode === 'dark' ? 'neutral.900' : 'background.surface',
            borderRadius: 'md',
          }}
        >
          <UserPromptJourney />
        </TabPanel>

        <TabPanel
          value="infra"
          sx={{
            p: 0,
            flex: 1,
            overflow: 'auto',
            bgcolor: mode === 'dark' ? 'neutral.900' : 'background.surface',
            borderRadius: 'md',
          }}
        >
          <InfrastructureOverview />
        </TabPanel>

        <TabPanel
          value="rag"
          sx={{
            p: 0,
            flex: 1,
            overflow: 'auto',
            bgcolor: mode === 'dark' ? 'neutral.900' : 'background.surface',
            borderRadius: 'md',
          }}
        >
          <RagPipeline />
        </TabPanel>

        <TabPanel
          value="security"
          sx={{
            p: 0,
            flex: 1,
            overflow: 'auto',
            bgcolor: mode === 'dark' ? 'neutral.900' : 'background.surface',
            borderRadius: 'md',
          }}
        >
          <SecurityArchitecture />
        </TabPanel>
      </Tabs>
    </Box>
  );
};

export default ArchitectureDiagramsTab;
