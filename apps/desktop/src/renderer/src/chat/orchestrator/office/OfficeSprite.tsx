import Box from '@mui/joy/Box';
import { keyframes } from '@mui/system';
import { OFFICE_CAST, OFFICE_PARENT } from './officeCast';

const workingMotion = keyframes`0%, 100% { transform: translateY(0); } 50% { transform: translateY(-1px); }`;
const typingMotion = keyframes`0%, 100% { transform: translateY(0); } 50% { transform: translateY(-2px); }`;
const attentionMotion = keyframes`0%, 70%, 100% { transform: rotate(0deg); } 78% { transform: rotate(-8deg); } 88% { transform: rotate(8deg); }`;
const steamMotion = keyframes`0% { opacity: 0; transform: translate(0, 1px); } 25% { opacity: .7; } 100% { opacity: 0; transform: translate(1px, -6px); }`;

const PALETTES = [
  ['#65432e', '#c9dce5', '#e3b28c'],
  ['#6a4325', '#d7bd63', '#e4b98e'],
  ['#985c32', '#cd9396', '#edbd9c'],
  ['#382b27', '#bec9db', '#895b40'],
  ['#75472d', '#b28da8', '#e6b799'],
  ['#bca06a', '#a8b599', '#edc9a6'],
  ['#332a27', '#a1c4ac', '#b98159'],
  ['#65442f', '#d7c9aa', '#dfaf88'],
  ['#a4492a', '#90b8a7', '#edb899'],
  ['#99958a', '#a3b0a2', '#d6a384'],
  ['#292322', '#d1d3cb', '#e4b58f'],
  ['#292020', '#c56f9e', '#b98159'],
  ['#ba8c56', '#c5b58d', '#e9bf99'],
  ['#805333', '#91b0ca', '#e4b28d'],
  ['#242324', '#607f99', '#895a3c'],
  ['#aa4c29', '#9db58e', '#edbf9f'],
];

export function OfficeSprite({
  name,
  resting = false,
  working = false,
  attention = false,
}: {
  name: string;
  resting?: boolean;
  working?: boolean;
  attention?: boolean;
}) {
  const index = OFFICE_CAST.findIndex(character => character === name);
  const [hair, shirt, skin] =
    name === OFFICE_PARENT ? ['#342c29', '#39495e', '#e5b38e'] : (PALETTES[index] ?? PALETTES[0]);
  const longHair = [2, 4, 5, 8, 11, 15].includes(index);
  return (
    <Box
      component="svg"
      data-office-sprite={name}
      data-active={working || attention ? 'true' : undefined}
      viewBox="0 0 24 36"
      width="48"
      height="72"
      shapeRendering="crispEdges"
      aria-hidden="true"
      sx={{
        imageRendering: 'pixelated',
        overflow: 'visible',
        animation: working && !resting ? `${workingMotion} 800ms steps(2, end) infinite` : 'none',
        '& [data-hand]': { animation: working && !resting ? `${typingMotion} 320ms steps(2, end) infinite` : 'none' },
        '& [data-hand="right"]': { animationDelay: '160ms' },
        '& [data-attention-arm]': {
          transformOrigin: '18px 17px',
          animation: attention && !resting ? `${attentionMotion} 1800ms steps(3, end) infinite` : 'none',
        },
        '& [data-coffee-steam]': { animation: `${steamMotion} 2200ms linear infinite`, pointerEvents: 'none' },
        '& [data-coffee-steam="second"]': { animationDelay: '-1100ms' },
        '@media (prefers-reduced-motion: reduce)': {
          animation: 'none',
          '& [data-hand], & [data-attention-arm]': { animation: 'none' },
          '& [data-coffee-steam]': { animation: 'none', opacity: 0.5 },
        },
      }}
    >
      <rect x="3" y="33" width="18" height="2" fill="#26302b" opacity=".25" />
      {longHair && <path d="M5 5H19V21H4V9H5Z" fill={hair} />}
      <path d="M6 21H18V28H16V33H13V27H11V33H7V28H6Z" fill="#424640" />
      <path d="M6 32H11V35H5V33H6ZM13 32H17V33H19V35H13Z" fill="#272b2d" />
      <path d="M7 15H17V17H20V25H17V22H7V25H4V17H7Z" fill={shirt} />
      <path d="M10 14H14V18H10Z" fill={skin} />
      <path d="M8 16L11 19H13L16 16H14L12 18L10 16Z" fill="#eee7ce" />
      <path d="M12 19H13V25H11V20H12Z" fill={index === 1 ? '#8b6130' : '#4b5f66'} />
      <path d="M6 4H18V7H19V12H17V14H15V16H9V14H7V12H5V7H6Z" fill={skin} />
      {index === 7 ? (
        <path d="M6 4H18V7H16V5H8V7H6Z" fill={hair} />
      ) : (
        <path d="M7 2H17V3H19V8H17V6H12V5H8V9H5V5H7Z" fill={hair} />
      )}
      {longHair && <path d="M5 7H7V17H4V9H5ZM17 6H19V18H17Z" fill={hair} />}
      <path d="M8 9H10V11H8ZM14 9H16V11H14Z" fill="#30312e" />
      <path d="M10 13H14V14H10Z" fill="#a36e52" />
      {[1, 4].includes(index) && (
        <path d="M7 8H11V12H7ZM13 8H17V12H13ZM11 9H13" fill="none" stroke="#594a30" strokeWidth="1" />
      )}
      {resting ? (
        <>
          <path d="M17 20H22V25H17Z" fill="#f4edd5" />
          <path d="M22 21H24V24H22" fill="none" stroke="#e2d9be" />
          <path d="M18 20H21" stroke="#71503a" />
          <path data-coffee-steam="first" d="M18 18V16H19V14" fill="none" stroke="#f4edd5" opacity="0" />
          <path data-coffee-steam="second" d="M21 18V15H20V13" fill="none" stroke="#f4edd5" opacity="0" />
          <rect x="17" y="25" width="4" height="2" fill={skin} />
        </>
      ) : (
        <>
          <path data-hand="left" d={working ? 'M4 23H8V25H4Z' : 'M4 24H7V27H4Z'} fill={skin} />
          <g data-attention-arm>
            {attention && <path d="M17 16H20V12H23V20H17Z" fill={shirt} />}
            <path
              data-hand="right"
              d={attention ? 'M20 9H23V13H20Z' : working ? 'M16 23H20V25H16Z' : 'M17 24H20V27H17Z'}
              fill={skin}
            />
          </g>
        </>
      )}
    </Box>
  );
}
