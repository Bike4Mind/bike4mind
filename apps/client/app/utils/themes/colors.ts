import { alpha } from '@mui/system';

// Base color palettes

/**
 * Brand color palette
 * Primary blue tones used throughout the application
 */
export const brand = {
  100: '#D1E4F4', // text color
  400: '#335F70', // mid tone
  500: '#3b82f6', // brand blue for gradients
  600: '#0A3D50', // dark navy blue
  700: '#2A4159', // selected
  800: '#0B6BCB', // main button
  900: '#0959AA', // main button hover
};

/**
 * Gray color palette
 * Neutral tones for backgrounds, borders, and text
 */
export const gray = {
  0: '#FFFFFF', // white
  5: '#f1f5f9', // light slate background
  8: '#f3f4f6', // very light gray background
  10: '#FBFCFE', // light body background
  12: '#F0F3F5', // light background
  15: '#f8fafc', // very light gray for backgrounds
  25: '#F7F9FB', // light menu bg
  50: '#F4F7F9', // surface light
  55: '#E8F4F8', // maintenance page light gradient end
  75: '#E2ECF4', // light reply bg
  100: '#DDE7EE', // light topbar bg
  150: '#BED1DF', // light border
  155: '#f1f1f1', // scrollbar track
  160: '#C9CBCD', // border color
  175: '#E0E0E0', // light gray for toggle buttons
  185: '#E8EAED', // light gray for fillable svg
  188: '#e2e8f0', // slate-200 voice session light border
  190: '#E5E7EB', // light border for pickers
  200: '#D3DFE8', // light stroke
  210: '#D3E4F4', // fallback file icon color
  220: '#abb2bf', // code editor text light gray
  600: '#737B82', // medium gray for borders and buttons
  650: '#636B74', // disabled states
  653: '#555555', // form label text color
  655: '#5a5a5a', // scrollbar thumb hover light gray
  660: '#4a4a4a', // scrollbar thumb medium gray
  665: '#666', // scrollbar thumb hover
  668: '#808080', // slider box shadow gray
  670: '#888888', // slider gray
  680: '#64748b', // slate for gradients
  685: '#9ca3af', // gray-400 voice session unknown status
  690: '#6b7280', // slate for gradients
  700: '#30363A', // dark neutral for placeholders and borders
  710: '#32383E', // disabled button text color
  720: '#4b5563', // dark slate for gradients
  725: '#374151', // medium-dark gray for text
  730: '#444444', // slider rail gray
  740: '#282c34', // code editor dark background
  750: '#475569', // slate gray for dark gradients
  775: '#2A2C38', // hover and overlay backgrounds
  780: '#1e293b', // dark slate for gradients
  800: '#2C3135', // stroke
  825: '#14191D', // darker gray
  830: '#1e1e1e', // scrollbar track dark
  845: '#131C1C', // chip/option dark background
  850: '#13181C', // main bg
  860: '#1f2937', // gray-800 voice session dark gradient start
  865: '#1A2332', // maintenance page dark gradient end
  870: '#111827', // gray-900 voice session dark gradient end
  875: '#101111', // input background dark
  900: '#0E1214', // surface dark
  925: '#0D0F10', // very dark border
};

/**
 * Green color palette
 * Success states and positive feedback
 */
export const green = {
  375: '#34d399', // emerald-300 voice session connected status
  400: '#10b981', // emerald green for gradients
  450: '#4ade80', // green-400 for audio visualization user light
  500: '#22C55E',
  550: '#16a34a', // green-600 for audio visualization user dark
  600: '#4CAF50', // success feedback
  650: '#059669', // darker emerald for gradients
  800: '#1FB84B',
  850: '#1FB94B', // alternate success green
  875: '#1a9d3f', // darker success green — Activate button hover
  900: '#1E7A20',
  925: '#1F7A1F', // password validation success
  950: '#167230', // darker success state for checkboxes
  975: '#1a3a1f', // very dark green toggle background
};

/**
 * Red color palette
 * Error states and critical alerts
 */
export const red = {
  250: '#ffebee', // very light red background
  300: '#F09898', // light red for dark mode delete icons
  325: '#EA3D3D', // danger red for buttons
  330: '#d32f2f', // Material UI error red
  375: '#f87171', // red-400 voice session disconnected status
  400: '#ef4444', // error/warning icons
  450: '#FF6B6B', // coral red
  500: '#E64A4A', // softer red for feedback
  550: '#dc2626', // red for gradients
  600: '#DA3131',
  700: '#C41C1C',
};

/**
 * Orange color palette
 * Warning states, attention-grabbing elements, and file quick actions
 */
export const orange = {
  300: '#FFA726', // thumbs down feedback
  350: '#FFAC58', // warning color
  375: '#fb923c', // schedule section highlights
  400: '#E8845A', // file quick action
  425: '#EA9A3D', // pending invite status
  430: '#f5a623', // chunking progress color
  450: '#FFA500', // warning yellow-orange
  500: '#F97316',
  550: '#f59e0b', // amber for gradients
  600: '#EA580C',
  625: '#fbbf24', // amber-300 voice session connecting status
  650: '#d97706', // darker amber for gradients
};

/**
 * Blue color palette
 * Quick actions and interactive elements
 */
export const blue = {
  400: '#0ea5e9', // sky blue for gradients
  500: '#4A90E2', // muted blue for feedback
  550: '#61afef', // code editor cursor blue
  600: '#0066C1', // notebook quick action
  650: '#0d6efd', // bootstrap primary blue
  700: '#0284c7', // darker sky blue for gradients
  750: '#1565c0', // referral button hover blue
  775: '#1976d2', // referral button blue
  800: '#2563eb', // blue for gradients
};

/**
 * Teal color palette
 * Project and productivity elements
 */
export const teal = {
  600: '#3A9D60', // project quick action
};

/**
 * Purple color palette
 * Agent and AI-related elements
 */
export const purple = {
  300: '#6366f1', // research/indigo purple
  325: '#a5b4fc', // indigo-300 shimmer text effect
  350: '#667eea', // agent modal gradient start
  400: '#818cf8', // light purple for gradients
  500: '#8b5cf6', // medium purple for gradients
  550: '#9333ea', // purple for alpha gradients
  600: '#9857B1', // agent quick action
  700: '#7c3aed', // darker purple for gradients
  750: '#764ba2', // agent modal gradient end
};

/**
 * Cyan color palette
 * Ocean and water-related elements
 */
export const cyan = {
  50: '#f0f9ff', // very light cyan
  100: '#e0f2fe', // light cyan
  300: '#2AC6F9', // bright blue nav links
  400: '#06b6d4', // cyan for gradients
  500: '#0891b2', // darker cyan for gradients
  600: '#00ffff', // pure cyan for special effects
};

/**
 * Pink color palette
 * Accent and highlight elements
 */
export const pink = {
  400: '#ec4899', // pink for gradients
  500: '#db2777', // darker pink for gradients
};

/**
 * Gold color palette
 * Premium and special highlight elements
 */
export const gold = {
  400: '#ffd700', // premium gold for special styling
};

// Alpha color variants

/**
 * Brand opacity variants using MUI's alpha helper
 */
export const brandAlpha = {
  // brand[100] (#D1E4F4) with opacity - Light text and background tints
  100: {
    4: alpha(brand[100], 0.04), // #D1E4F40A / rgba(209, 228, 244, 0.04)
    5: alpha(brand[100], 0.05), // #D1E4F40D / rgba(209, 228, 244, 0.05)
    8: alpha(brand[100], 0.08), // #D1E4F414 / rgba(209, 228, 244, 0.08)
    12: alpha(brand[100], 0.12), // #D1E4F41F / rgba(209, 228, 244, 0.12)
    15: alpha(brand[100], 0.15), // #D1E4F426 / rgba(209, 228, 244, 0.15)
    20: alpha(brand[100], 0.2), // #D1E4F433 / rgba(209, 228, 244, 0.2)
    25: alpha(brand[100], 0.25), // #D1E4F440 / rgba(209, 228, 244, 0.25)
    30: alpha(brand[100], 0.3), // #D1E4F44D / rgba(209, 228, 244, 0.3)
    35: alpha(brand[100], 0.35), // #D1E4F459 / rgba(209, 228, 244, 0.35)
    50: alpha(brand[100], 0.5), // #D1E4F480 / rgba(209, 228, 244, 0.5)
    70: alpha(brand[100], 0.7), // #D1E4F4B3 / rgba(209, 228, 244, 0.7)
    75: alpha(brand[100], 0.75), // #D1E4F4BF / rgba(209, 228, 244, 0.75)
    80: alpha(brand[100], 0.8), // #D1E4F4CC / rgba(209, 228, 244, 0.8)
  },

  // brand[400] (#335F70) with opacity - Mid-tone elements
  400: {
    5: alpha(brand[400], 0.05), // #335F700D / rgba(51, 95, 112, 0.05)
    7: alpha(brand[400], 0.07), // #335F7012 / rgba(51, 95, 112, 0.07)
    8: alpha(brand[400], 0.08), // #335F7014 / rgba(51, 95, 112, 0.08)
    25: alpha(brand[400], 0.25), // #335F7040 / rgba(51, 95, 112, 0.25)
    30: alpha(brand[400], 0.3), // #335F704D / rgba(51, 95, 112, 0.3)
    35: alpha(brand[400], 0.35), // #335F7059 / rgba(51, 95, 112, 0.35)
    40: alpha(brand[400], 0.4), // #335F7066 / rgba(51, 95, 112, 0.4)
    50: alpha(brand[400], 0.5), // #335F7080 / rgba(51, 95, 112, 0.5)
    60: alpha(brand[400], 0.6), // #335F7099 / rgba(51, 95, 112, 0.6)
    70: alpha(brand[400], 0.7), // #335F70B3 / rgba(51, 95, 112, 0.7)
  },

  // brand[500] (#3b82f6) with opacity - Main brand blue for gradients and shadows
  500: {
    5: alpha(brand[500], 0.05), // #3b82f60D / rgba(59, 130, 246, 0.05)
    8: alpha(brand[500], 0.08), // #3b82f614 / rgba(59, 130, 246, 0.08)
    10: alpha(brand[500], 0.1), // #3b82f61A / rgba(59, 130, 246, 0.1)
    15: alpha(brand[500], 0.15), // #3b82f626 / rgba(59, 130, 246, 0.15)
    25: alpha(brand[500], 0.25), // #3b82f640 / rgba(59, 130, 246, 0.25)
    30: alpha(brand[500], 0.3), // #3b82f64D / rgba(59, 130, 246, 0.3)
    40: alpha(brand[500], 0.4), // #3b82f666 / rgba(59, 130, 246, 0.4)
    60: alpha(brand[500], 0.6), // #3b82f699 / rgba(59, 130, 246, 0.6)
  },

  // brand[600] (#0A3D50) with opacity - Dark navy blue shadows
  600: {
    4: alpha(brand[600], 0.04), // #0A3D500A / rgba(10, 61, 80, 0.04)
    20: alpha(brand[600], 0.2), // #0A3D5033 / rgba(10, 61, 80, 0.20)
  },

  // brand[700] (#2A4159) with opacity - Selected states and shadows
  700: {
    3: alpha(brand[700], 0.03), // #2A415908 / rgba(42, 65, 89, 0.03)
  },

  // brand[800] (#0B6BCB) with opacity - Button and active states
  800: {
    1: alpha(brand[800], 0.01), // #0B6BCB03 / rgba(11, 107, 203, 0.01)
    2: alpha(brand[800], 0.02), // #0B6BCB05 / rgba(11, 107, 203, 0.02)
    5: alpha(brand[800], 0.05), // #0B6BCB0D / rgba(11, 107, 203, 0.05)
    8: alpha(brand[800], 0.08), // #0B6BCB14 / rgba(11, 107, 203, 0.08)
    10: alpha(brand[800], 0.1), // #0B6BCB1A / rgba(11, 107, 203, 0.1)
    12: alpha(brand[800], 0.12), // #0B6BCB1F / rgba(11, 107, 203, 0.12)
    15: alpha(brand[800], 0.15), // #0B6BCB26 / rgba(11, 107, 203, 0.15)
    20: alpha(brand[800], 0.2), // #0B6BCB33 / rgba(11, 107, 203, 0.2)
    25: alpha(brand[800], 0.25), // #0B6BCB40 / rgba(11, 107, 203, 0.25)
    50: alpha(brand[800], 0.5), // #0B6BCB80 / rgba(11, 107, 203, 0.5)
  },
} as const;

/**
 * Gray opacity variants using MUI's alpha helper
 */
export const grayAlpha = {
  // gray[0] (#FFFFFF) with opacity - White dividers and text
  0: {
    20: alpha(gray[0], 0.2), // #FFFFFF33 / rgba(255, 255, 255, 0.2)
    50: alpha(gray[0], 0.5), // #FFFFFF80 / rgba(255, 255, 255, 0.5)
  },

  // gray[5] (#f1f5f9) with opacity - Light slate backgrounds
  5: {
    98: alpha(gray[5], 0.98), // #f1f5f9FA / rgba(241, 245, 249, 0.98)
  },

  // gray[15] (#f8fafc) with opacity - Very light backgrounds
  15: {
    90: alpha(gray[15], 0.9), // #f8fafce6 / rgba(248, 250, 252, 0.9)
    95: alpha(gray[15], 0.95), // #f8fafcf2 / rgba(248, 250, 252, 0.95)
    96: alpha(gray[15], 0.96), // #f8fafcf5 / rgba(248, 250, 252, 0.96)
  },

  // gray[150] (#BED1DF) with opacity - Light borders
  150: {
    10: alpha(gray[150], 0.1), // #BED1DF1A / rgba(190, 209, 223, 0.1)
    20: alpha(gray[150], 0.2), // #BED1DF33 / rgba(190, 209, 223, 0.2)
    30: alpha(gray[150], 0.3), // #BED1DF4D / rgba(190, 209, 223, 0.3)
    50: alpha(gray[150], 0.5), // #BED1DF80 / rgba(190, 209, 223, 0.5)
    80: alpha(gray[150], 0.8), // #BED1DFCC / rgba(190, 209, 223, 0.8)
  },

  // gray[160] (#C9CBCD) with opacity - Border colors
  160: {
    50: alpha(gray[160], 0.5), // #C9CBCD80 / rgba(201, 203, 205, 0.5)
  },

  // gray[175] (#E0E0E0) with opacity - Light gray toggle buttons
  175: {
    12: alpha(gray[175], 0.12), // #E0E0E01F / rgba(224, 224, 224, 0.12)
  },

  // gray[200] (#D3DFE8) with opacity - Light stroke and icon colors
  200: {
    20: alpha(gray[200], 0.2), // #D3DFE833 / rgba(211, 223, 232, 0.2)
    50: alpha(gray[200], 0.5), // #D3DFE880 / rgba(211, 223, 232, 0.5)
    60: alpha(gray[200], 0.6), // #D3DFE899 / rgba(211, 223, 232, 0.6)
  },

  // gray[210] (#D3E4F4) with opacity - Fallback file icon colors
  210: {
    50: alpha(gray[210], 0.5), // #D3E4F480 / rgba(211, 228, 244, 0.5)
  },

  // gray[600] (#737B82) with opacity - Medium gray for borders and buttons
  600: {
    3: alpha(gray[600], 0.03), // #737B8208 / rgba(115, 123, 130, 0.03)
  },

  // gray[690] (#6b7280) with opacity - Slate for gradients
  690: {
    15: alpha(gray[690], 0.15), // #6b728026 / rgba(107, 114, 128, 0.15)
    40: alpha(gray[690], 0.4), // #6b728066 / rgba(107, 114, 128, 0.4)
  },

  // gray[700] (#30363A) with opacity - Dark borders and placeholders
  700: {
    50: alpha(gray[700], 0.5), // #30363A80 / rgba(48, 54, 58, 0.5)
  },

  // gray[775] (#2A2C38) with opacity - Dark surfaces and overlays
  775: {
    25: alpha(gray[775], 0.25), // #2A2C3840 / rgba(42, 44, 56, 0.25)
    30: alpha(gray[775], 0.3), // #2A2C384D / rgba(42, 44, 56, 0.3)
    50: alpha(gray[775], 0.5), // #2A2C3880 / rgba(42, 44, 56, 0.5)
    60: alpha(gray[775], 0.6), // #2A2C3899 / rgba(42, 44, 56, 0.6)
    70: alpha(gray[775], 0.7), // #2A2C38B3 / rgba(42, 44, 56, 0.7)
  },

  // gray[780] (#1e293b) with opacity - Dark slate overlays
  780: {
    72: alpha(gray[780], 0.72), // #1e293bB8 / rgba(30, 41, 59, 0.72)
  },

  // gray[800] (#2C3135) with opacity - Stroke colors and overlays
  800: {
    8: alpha(gray[800], 0.08), // #2C313514 / rgba(44, 49, 53, 0.08)
    50: alpha(gray[800], 0.5), // #2C313580 / rgba(44, 49, 53, 0.5)
  },

  // gray[668] (#808080) with opacity - Slider box shadow effects
  668: {
    16: alpha(gray[668], 0.16), // #80808029 / rgba(128, 128, 128, 0.16)
  },

  // gray[670] (#888888) with opacity - Slider hover effects
  670: {
    16: alpha(gray[670], 0.16), // #88888829 / rgba(136, 136, 136, 0.16)
  },

  // gray[710] (#32383E) with opacity - Disabled button backgrounds
  710: {
    50: alpha(gray[710], 0.5), // #32383E80 / rgba(50, 56, 62, 0.5)
  },

  // gray[875] (#101111) with opacity - Dark input backgrounds
  875: {
    50: alpha(gray[875], 0.5), // #10111180 / rgba(16, 17, 17, 0.5)
  },

  // gray[725] (#374151) with opacity - Voice session dark mode borders
  725: {
    30: alpha(gray[725], 0.3), // #37415140 / rgba(55, 65, 81, 0.3)
    50: alpha(gray[725], 0.5), // #37415180 / rgba(55, 65, 81, 0.5)
  },
} as const;

/**
 * Green opacity variants using MUI's alpha helper
 */
export const greenAlpha = {
  // green[400] (#10b981) with opacity - Emerald green variants
  400: {
    40: alpha(green[400], 0.4), // #10b98166 / rgba(16, 185, 129, 0.4)
  },

  // green[375] (#34d399) with opacity - Dark mode soft variant backgrounds
  375: {
    15: alpha(green[375], 0.15), // #34d39926 / rgba(52, 211, 153, 0.15) - dark mode soft bg
    22: alpha(green[375], 0.22), // #34d39938 / rgba(52, 211, 153, 0.22) - dark mode soft hover bg
    28: alpha(green[375], 0.28), // #34d39947 / rgba(52, 211, 153, 0.28) - dark mode soft active bg
  },

  // green[500] (#22C55E) with opacity - Success feedback
  500: {
    2: alpha(green[500], 0.02), // #22C55E05 / rgba(34, 197, 94, 0.02)
    15: alpha(green[500], 0.15), // #22C55E26 / rgba(34, 197, 94, 0.15)
  },

  // green[600] (#4CAF50) with opacity - Success feedback
  600: {
    12: alpha(green[600], 0.12), // #4CAF501F / rgba(76, 175, 80, 0.12)
  },

  // green[800] (#1FB84B) with opacity - Success states and positive feedback
  800: {
    2: alpha(green[800], 0.02), // #1FB84B05 / rgba(31, 184, 75, 0.02)
    4: alpha(green[800], 0.04), // #1FB84B0A / rgba(31, 184, 75, 0.04)
    5: alpha(green[800], 0.05), // #1FB84B0D / rgba(31, 184, 75, 0.05)
    6: alpha(green[800], 0.06), // #1FB84B0F / rgba(31, 184, 75, 0.06)
    8: alpha(green[800], 0.08), // #1FB84B14 / rgba(31, 184, 75, 0.08)
    10: alpha(green[800], 0.1), // #1FB84B1A / rgba(31, 184, 75, 0.1)
    15: alpha(green[800], 0.15), // #1FB84B26 / rgba(31, 184, 75, 0.15)
    20: alpha(green[800], 0.2), // #1FB84B33 / rgba(31, 184, 75, 0.2)
    30: alpha(green[800], 0.3), // #1FB84B4D / rgba(31, 184, 75, 0.3)
    50: alpha(green[800], 0.5), // #1FB84B80 / rgba(31, 184, 75, 0.5)
  },

  // green[900] (#1E7A20) with opacity - Success accents and backgrounds
  900: {
    5: alpha(green[900], 0.05), // #1E7A200D / rgba(30, 122, 32, 0.05)
  },

  // green[950] (#167230) with opacity - Darker success states for checkboxes
  950: {
    20: alpha(green[950], 0.2), // #16723033 / rgba(22, 114, 48, 0.2)
    40: alpha(green[950], 0.4), // #16723066 / rgba(22, 114, 48, 0.4)
  },
} as const;

/**
 * Teal opacity variants using MUI's alpha helper
 */
export const tealAlpha = {
  // Custom teal color (#5CB8A6) with opacity - Preview and special elements
  custom: {
    5: alpha('#5CB8A6', 0.05), // #5CB8A60D / rgba(92, 184, 166, 0.05)
  },
} as const;

/**
 * White opacity variants using MUI's alpha helper
 */
export const whiteAlpha = {
  // Pure white (#FFFFFF) with opacity - Light overlays and hover states
  0: {
    5: alpha('#FFFFFF', 0.05), // #FFFFFF0D / rgba(255, 255, 255, 0.05)
    10: alpha('#FFFFFF', 0.1), // #FFFFFF1A / rgba(255, 255, 255, 0.1)
    12: alpha('#FFFFFF', 0.12), // #FFFFFF1F / rgba(255, 255, 255, 0.12)
    20: alpha('#FFFFFF', 0.2), // #FFFFFF33 / rgba(255, 255, 255, 0.2)
    30: alpha('#FFFFFF', 0.3), // #FFFFFF4D / rgba(255, 255, 255, 0.3)
    50: alpha('#FFFFFF', 0.5), // #FFFFFF80 / rgba(255, 255, 255, 0.5)
    70: alpha('#FFFFFF', 0.7), // #FFFFFFB3 / rgba(255, 255, 255, 0.7)
    80: alpha('#FFFFFF', 0.8), // #FFFFFFCC / rgba(255, 255, 255, 0.8)
    90: alpha('#FFFFFF', 0.9), // #FFFFFFE6 / rgba(255, 255, 255, 0.9)
    95: alpha('#FFFFFF', 0.95), // #FFFFFFF2 / rgba(255, 255, 255, 0.95)
    96: alpha('#FFFFFF', 0.96), // #FFFFFFF5 / rgba(255, 255, 255, 0.96)
    98: alpha('#FFFFFF', 0.98), // #FFFFFAFA / rgba(255, 255, 255, 0.98)
  },
} as const;

/**
 * Black opacity variants using MUI's alpha helper
 */
export const blackAlpha = {
  // Pure black (#000000) with opacity - Shadows and overlays
  0: {
    1: alpha('#000000', 0.01), // #00000003 / rgba(0, 0, 0, 0.01)
    2: alpha('#000000', 0.02), // #00000005 / rgba(0, 0, 0, 0.02)
    3: alpha('#000000', 0.03), // #00000008 / rgba(0, 0, 0, 0.03)
    4: alpha('#000000', 0.04), // #0000000A / rgba(0, 0, 0, 0.04)
    5: alpha('#000000', 0.05), // #0000000D / rgba(0, 0, 0, 0.05)
    6: alpha('#000000', 0.06), // #0000000F / rgba(0, 0, 0, 0.06)
    8: alpha('#000000', 0.08), // #00000014 / rgba(0, 0, 0, 0.08)
    10: alpha('#000000', 0.1), // #0000001A / rgba(0, 0, 0, 0.1)
    12: alpha('#000000', 0.12), // #0000001F / rgba(0, 0, 0, 0.12)
    15: alpha('#000000', 0.15), // #00000026 / rgba(0, 0, 0, 0.15)
    18: alpha('#000000', 0.18), // #0000002E / rgba(0, 0, 0, 0.18)
    20: alpha('#000000', 0.2), // #00000033 / rgba(0, 0, 0, 0.2)
    25: alpha('#000000', 0.25), // #00000040 / rgba(0, 0, 0, 0.25)
    30: alpha('#000000', 0.3), // #0000004D / rgba(0, 0, 0, 0.3)
    50: alpha('#000000', 0.5), // #00000080 / rgba(0, 0, 0, 0.5)
  },
} as const;

/**
 * Red opacity variants using MUI's alpha helper
 */
export const redAlpha = {
  // red[325] (#EA3D3D) with opacity - Danger red for buttons
  325: {
    8: alpha(red[325], 0.08), // #EA3D3D14 / rgba(234, 61, 61, 0.08)
    50: alpha(red[325], 0.5), // #EA3D3D80 / rgba(234, 61, 61, 0.5)
  },

  // red[400] (#ef4444) with opacity - Error/warning icons
  400: {
    15: alpha(red[400], 0.15), // #ef444426 / rgba(239, 68, 68, 0.15) - dark mode soft bg
    22: alpha(red[400], 0.22), // #ef444438 / rgba(239, 68, 68, 0.22) - dark mode soft hover bg
    28: alpha(red[400], 0.28), // #ef444447 / rgba(239, 68, 68, 0.28) - dark mode soft active bg
    40: alpha(red[400], 0.4), // #ef444466 / rgba(239, 68, 68, 0.4)
  },

  // red[450] (#FF6B6B) with opacity - Coral red states
  450: {
    10: alpha(red[450], 0.1), // #FF6B6B1A / rgba(255, 107, 107, 0.1)
  },

  // red[600] (#DA3131) with opacity - Error and danger states
  600: {
    10: alpha(red[600], 0.1), // #DA31311A / rgba(218, 49, 49, 0.1)
    20: alpha(red[600], 0.2), // #DA313133 / rgba(218, 49, 49, 0.2)
  },
} as const;

/**
 * Purple opacity variants using MUI's alpha helper
 */
export const purpleAlpha = {
  // purple[500] (#8b5cf6) with opacity - Purple gradients and accents
  500: {
    2: alpha(purple[500], 0.02), // #8b5cf605 / rgba(139, 92, 246, 0.02)
    5: alpha(purple[500], 0.05), // #8b5cf60D / rgba(139, 92, 246, 0.05)
    8: alpha(purple[500], 0.08), // #8b5cf614 / rgba(139, 92, 246, 0.08)
    15: alpha(purple[500], 0.15), // #8b5cf626 / rgba(139, 92, 246, 0.15)
    40: alpha(purple[500], 0.4), // #8b5cf666 / rgba(139, 92, 246, 0.4)
  },

  // purple[550] (#9333ea) with opacity - Purple gradients and highlights
  550: {
    5: alpha(purple[550], 0.05), // #9333ea0D / rgba(147, 51, 234, 0.05)
    8: alpha(purple[550], 0.08), // #9333ea14 / rgba(147, 51, 234, 0.08)
  },

  // purple[325] (#a5b4fc) with opacity - Indigo shimmer text effects
  325: {
    20: alpha(purple[325], 0.2), // #a5b4fc33 / rgba(165, 180, 252, 0.2)
  },
} as const;

/**
 * Orange opacity variants using MUI's alpha helper
 */
export const orangeAlpha = {
  // orange[350] (#FFAC58) with opacity - Warning colors
  350: {
    10: alpha(orange[350], 0.1), // #FFAC581A / rgba(255, 172, 88, 0.1)
  },

  // orange[375] (#fb923c) with opacity - Schedule section highlights & dark mode soft variants
  375: {
    2: alpha(orange[375], 0.02), // #fb923c05 / rgba(251, 146, 60, 0.02)
    15: alpha(orange[375], 0.15), // #fb923c26 / rgba(251, 146, 60, 0.15) - dark mode soft bg
    22: alpha(orange[375], 0.22), // #fb923c38 / rgba(251, 146, 60, 0.22) - dark mode soft hover bg
    28: alpha(orange[375], 0.28), // #fb923c47 / rgba(251, 146, 60, 0.28) - dark mode soft active bg
  },

  // orange[450] (#FFA500) with opacity - Warning soft variants (Alert/chip bg)
  450: {
    15: alpha(orange[450], 0.15), // #FFA50026 - soft bg
    22: alpha(orange[450], 0.22), // #FFA50038 - soft hover bg
    28: alpha(orange[450], 0.28), // #FFA50047 - soft active bg
  },

  // orange[550] (#f59e0b) with opacity - Amber for gradients
  550: {
    15: alpha(orange[550], 0.15), // #f59e0b26 / rgba(245, 158, 11, 0.15)
    40: alpha(orange[550], 0.4), // #f59e0b66 / rgba(245, 158, 11, 0.4)
  },
} as const;

/**
 * Cyan opacity variants using MUI's alpha helper
 */
export const cyanAlpha = {
  // cyan[400] (#06b6d4) with opacity - Cyan for gradients
  400: {
    40: alpha(cyan[400], 0.4), // #06b6d466 / rgba(6, 182, 212, 0.4)
  },

  // cyan[600] (#00ffff) with opacity - Pure cyan for special effects
  600: {
    70: alpha(cyan[600], 0.7), // #00ffffB3 / rgba(0, 255, 255, 0.7)
  },
} as const;

/**
 * Pink opacity variants using MUI's alpha helper
 */
export const pinkAlpha = {
  // pink[400] (#ec4899) with opacity - Pink for gradients
  400: {
    40: alpha(pink[400], 0.4), // #ec489966 / rgba(236, 72, 153, 0.4)
  },
} as const;

/**
 * Blue opacity variants using MUI's alpha helper
 */
export const blueAlpha = {
  // blue[650] (#0d6efd) with opacity - Bootstrap primary blue
  650: {
    2: alpha(blue[650], 0.02), // #0d6efd05 / rgba(13, 110, 253, 0.02)
    15: alpha(blue[650], 0.15), // #0d6efd26 / rgba(13, 110, 253, 0.15)
    25: alpha(blue[650], 0.25), // #0d6efd40 / rgba(13, 110, 253, 0.25)
    50: alpha(blue[650], 0.5), // #0d6efd40 / rgba(13, 110, 253, 0.25)
    75: alpha(blue[650], 0.75), // #0d6efd40 / rgba(13, 110, 253, 0.25)
  },
} as const;

/**
 * Gold opacity variants using MUI's alpha helper
 */
export const goldAlpha = {
  // gold[400] (#ffd700) with opacity - Premium gold for special styling
  400: {
    10: alpha(gold[400], 0.1), // #ffd7001A / rgba(255, 215, 0, 0.1)
    20: alpha(gold[400], 0.2), // #ffd70033 / rgba(255, 215, 0, 0.2)
    30: alpha(gold[400], 0.3), // #ffd7004D / rgba(255, 215, 0, 0.3)
    40: alpha(gold[400], 0.4), // #ffd70066 / rgba(255, 215, 0, 0.4)
    50: alpha(gold[400], 0.5), // #ffd70080 / rgba(255, 215, 0, 0.5)
    60: alpha(gold[400], 0.6), // #ffd70099 / rgba(255, 215, 0, 0.6)
    70: alpha(gold[400], 0.7), // #ffd700B3 / rgba(255, 215, 0, 0.7)
    80: alpha(gold[400], 0.8), // #ffd700CC / rgba(255, 215, 0, 0.8)
    90: alpha(gold[400], 0.9), // #ffd700E6 / rgba(255, 215, 0, 0.9)
    100: gold[400], // #ffd700FF / rgba(255, 215, 0, 1.0)
  },
} as const;

/**
 * Unique theme colors
 */
export const unique = {
  // Interactive states
  softHoverColor: '#E3EFFB', // soft hover text color

  // Disabled states
  solidDisabledColor: '#32383E', // disabled button text (close to gray[700])

  // App surfaces
  scrollbar: '#AEBFC7', // scrollbar thumb (single use)

  // Sidenav colors (single use)
  lightBlue: '#ADD8E6', // sidenav light blue background
  limeGreen: '#4CBB17', // sidenav CTA subscribe (light mode)

  // Searchbar colors (single use)
  mediumGray: '#A0A0A0', // searchbar color (light mode)

  // FileBrowser colors (single use)
  tealPreview: '#5CB8A6', // preview border color
  almostBlack: '#040506', // text danger color

  // SessionBottom colors (single use)
  lightBlueOverlay: '#F5FAFF', // light overlay background

  // GoogleDoc colors (single use)
  lightGrayBackground: '#F5F5F5', // file item background
};
