import { OFFICE_CAST, OFFICE_PARENT } from './officeCast';

const LOOKS = [
  ['#654b37', '#d7e7ed', '#e7be9b'],
  ['#765636', '#d6bf70', '#edc7a3'],
  ['#a16b42', '#dfb4b0', '#efc8ab'],
  ['#3e302b', '#b4c6d4', '#875b43'],
  ['#80513a', '#c9a8cb', '#edc5aa'],
  ['#b99b60', '#d0d7c5', '#f1d0b3'],
  ['#34302c', '#a7c8b9', '#bb8b65'],
  ['#554539', '#e0d6b8', '#ebc3a3'],
  ['#9f4936', '#b8d4c8', '#efc6aa'],
  ['#a2a29a', '#bdc5b8', '#dfb395'],
  ['#332b28', '#dee0e0', '#e8bc9a'],
  ['#292623', '#d695b5', '#bf8965'],
  ['#b79063', '#d1c7ad', '#e9c8ad'],
  ['#805c3c', '#a9c0d5', '#eac1a0'],
  ['#292826', '#7d9cb1', '#8c5c40'],
  ['#a75232', '#b0c5a5', '#f2cbb0'],
];

export function OfficePortrait({ name, resting = false }: { name: string; resting?: boolean }) {
  const index = OFFICE_CAST.findIndex(character => character === name);
  const [hair, shirt, skin] = name === OFFICE_PARENT ? ['#3b2c26', '#39495b', '#e7bc99'] : LOOKS[index] ?? LOOKS[0];
  return (
    <svg viewBox="0 0 64 76" width="58" height="69" aria-hidden="true" style={{ flexShrink: 0 }}>
      <ellipse cx="32" cy="72" rx="24" ry="3" fill="#283537" opacity=".15" />
      <path d="M12 68V48Q12 39 25 39H39Q52 39 52 48V68" fill={shirt} stroke="#384449" strokeWidth="1.5" />
      <path d="M26 39L32 48L38 39" fill="#f5f0df" />
      <path d="M32 47L29 60L32 64L35 60Z" fill={index === 1 ? '#74502a' : '#647267'} />
      <rect x="27" y="31" width="10" height="12" rx="3" fill={skin} />
      <ellipse cx="32" cy="23" rx="15" ry="18" fill={skin} />
      <path d={index === 7 ? 'M18 18Q16 2 32 3Q48 2 46 18L42 12Q30 8 22 15Z' : 'M17 26V16Q17 2 32 2Q49 2 47 22L42 12Q30 17 22 11L21 28Z'} fill={hair} />
      <circle cx="26" cy="24" r="1.3" fill="#323435" /><circle cx="38" cy="24" r="1.3" fill="#323435" />
      <path d="M28 32Q32 35 36 32" fill="none" stroke="#9f6d56" strokeWidth="1.4" />
      {(index === 1 || index === 4) && <g fill="none" stroke="#5a5542" strokeWidth="1.4"><rect x="20" y="20" width="10" height="7" rx="2" /><rect x="34" y="20" width="10" height="7" rx="2" /><path d="M30 23H34" /></g>}
      {resting && <g><path d="M40 52H51V64H40Z" fill="#f8f1db" /><path d="M51 54Q59 54 54 61H51" fill="none" stroke="#f8f1db" strokeWidth="3" /></g>}
    </svg>
  );
}

export function OfficeFurniture({ kind }: { kind: 'desk' | 'coffee' | 'reception' | 'meeting' }) {
  return (
    <svg viewBox="0 0 200 64" width="180" height="58" aria-hidden="true" style={{ maxWidth: '100%' }}>
      {kind === 'desk' ? <>
        <rect x="16" y="36" width="168" height="10" rx="2" fill="#b89061" /><path d="M24 46V62M176 46V62" stroke="#6c776d" strokeWidth="6" />
        <rect x="70" y="2" width="57" height="33" rx="3" fill="#48575b" /><rect x="75" y="7" width="47" height="23" fill="#aac3bb" /><path d="M99 35V40M88 40H110" stroke="#48575b" strokeWidth="4" />
        <path d="M33 30H55V36H33" fill="#f4eddb" /><rect x="139" y="24" width="10" height="13" fill="#eee6d3" />
      </> : kind === 'coffee' ? <>
        <rect x="8" y="16" width="110" height="45" fill="#c0a67d" /><rect x="5" y="12" width="116" height="6" fill="#f1e8d0" />
        <rect x="28" y="0" width="31" height="29" rx="2" fill="#414d4e" /><rect x="35" y="12" width="17" height="12" fill="#bac9c2" />
        <rect x="136" y="0" width="49" height="61" rx="3" fill="#6d8780" /><rect x="142" y="6" width="29" height="39" fill="#314448" /><path d="M146 17H167M146 28H167M146 39H167" stroke="#c6b477" strokeWidth="4" /><rect x="176" y="20" width="4" height="11" fill="#d4d7b9" />
      </> : kind === 'meeting' ? <>
        <ellipse cx="100" cy="30" rx="76" ry="21" fill="#b49368" /><path d="M60 44V61M140 44V61" stroke="#596960" strokeWidth="5" /><rect x="83" y="18" width="32" height="18" fill="#f1ebda" /><path d="M90 24H108M90 29H104" stroke="#9dafa4" strokeWidth="2" />
      </> : <>
        <rect x="15" y="18" width="170" height="40" fill="#bd9f76" /><rect x="9" y="13" width="182" height="9" fill="#e5d7b7" /><rect x="69" y="0" width="40" height="15" rx="2" fill="#4a5a5c" /><path d="M32 33H57M32 39H50" stroke="#e1cfaa" strokeWidth="3" /><circle cx="157" cy="7" r="8" fill="#819565" /><rect x="152" y="10" width="11" height="8" fill="#af7953" />
      </>}
    </svg>
  );
}
