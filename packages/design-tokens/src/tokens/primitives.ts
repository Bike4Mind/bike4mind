// Canonical color primitives shared by every first-party client.
// Values are data: literal color strings seeded from the web theme. Alpha
// variants are pre-materialized rgba() strings (integrity-checked against
// their base ramp entries in primitives.test.ts) so no platform needs a
// color library to consume them.

/** Brand color ramp: the primary blue tones used throughout the product. */
export const brand = {
  100: '#D1E4F4',
  400: '#335F70',
  500: '#3b82f6',
  600: '#0A3D50',
  650: '#0A2230',
  700: '#2A4159',
  800: '#0B6BCB',
  900: '#0959AA',
};

/** Neutral ramp for backgrounds, borders and text. */
export const gray = {
  0: '#FFFFFF',
  5: '#f1f5f9',
  8: '#f3f4f6',
  10: '#FBFCFE',
  12: '#F0F3F5',
  15: '#f8fafc',
  25: '#F7F9FB',
  50: '#F4F7F9',
  55: '#E8F4F8',
  75: '#E2ECF4',
  100: '#DDE7EE',
  150: '#BED1DF',
  155: '#f1f1f1',
  160: '#C9CBCD',
  175: '#E0E0E0',
  185: '#E8EAED',
  188: '#e2e8f0',
  190: '#E5E7EB',
  200: '#D3DFE8',
  210: '#D3E4F4',
  220: '#abb2bf',
  600: '#737B82',
  650: '#636B74',
  653: '#555555',
  655: '#5a5a5a',
  660: '#4a4a4a',
  665: '#666',
  668: '#808080',
  670: '#888888',
  680: '#64748b',
  685: '#9ca3af',
  690: '#6b7280',
  700: '#30363A',
  710: '#32383E',
  720: '#4b5563',
  725: '#374151',
  730: '#444444',
  740: '#282c34',
  750: '#475569',
  775: '#2A2C38',
  780: '#1e293b',
  800: '#2C3135',
  825: '#14191D',
  830: '#1e1e1e',
  845: '#131C1C',
  850: '#13181C',
  860: '#1f2937',
  865: '#1A2332',
  870: '#111827',
  875: '#101111',
  900: '#0E1214',
  925: '#0D0F10',
};

/** Success states and positive feedback. */
export const green = {
  375: '#34d399',
  400: '#10b981',
  450: '#4ade80',
  500: '#22C55E',
  550: '#16a34a',
  600: '#4CAF50',
  650: '#059669',
  800: '#1FB84B',
  850: '#1FB94B',
  875: '#1a9d3f',
  900: '#1E7A20',
  925: '#1F7A1F',
  950: '#167230',
  975: '#1a3a1f',
};

/** Error states and critical alerts. */
export const red = {
  250: '#ffebee',
  300: '#F09898',
  325: '#EA3D3D',
  330: '#d32f2f',
  375: '#f87171',
  400: '#ef4444',
  450: '#FF6B6B',
  500: '#E64A4A',
  550: '#dc2626',
  600: '#DA3131',
  700: '#C41C1C',
};

/** Warning states and attention-grabbing elements. */
export const orange = {
  300: '#FFA726',
  350: '#FFAC58',
  375: '#fb923c',
  400: '#E8845A',
  425: '#EA9A3D',
  430: '#f5a623',
  450: '#FFA500',
  500: '#F97316',
  550: '#f59e0b',
  600: '#EA580C',
  625: '#fbbf24',
  650: '#d97706',
};

/** Informational and interactive accents. */
export const blue = {
  400: '#0ea5e9',
  500: '#4A90E2',
  550: '#61afef',
  600: '#0066C1',
  650: '#0d6efd',
  700: '#0284c7',
  750: '#1565c0',
  775: '#1976d2',
  800: '#2563eb',
};

/** Project and productivity accents. */
export const teal = {
  600: '#3A9D60',
};

/** Agent and AI-related accents. */
export const purple = {
  300: '#6366f1',
  325: '#a5b4fc',
  350: '#667eea',
  400: '#818cf8',
  500: '#8b5cf6',
  550: '#9333ea',
  600: '#9857B1',
  700: '#7c3aed',
  750: '#764ba2',
};

/** Bright informational accents. */
export const cyan = {
  50: '#f0f9ff',
  100: '#e0f2fe',
  300: '#2AC6F9',
  400: '#06b6d4',
  500: '#0891b2',
  600: '#00ffff',
};

/** Highlight accents (gradients). */
export const pink = {
  400: '#ec4899',
  500: '#db2777',
};

/** Premium highlight accents. */
export const gold = {
  400: '#ffd700',
};

/** Translucent variants of the brand ramp (and fixed one-off bases), as rgba() strings. */
export const brandAlpha = {
  100: {
    4: 'rgba(209, 228, 244, 0.04)',
    5: 'rgba(209, 228, 244, 0.05)',
    8: 'rgba(209, 228, 244, 0.08)',
    12: 'rgba(209, 228, 244, 0.12)',
    15: 'rgba(209, 228, 244, 0.15)',
    20: 'rgba(209, 228, 244, 0.2)',
    25: 'rgba(209, 228, 244, 0.25)',
    30: 'rgba(209, 228, 244, 0.3)',
    35: 'rgba(209, 228, 244, 0.35)',
    50: 'rgba(209, 228, 244, 0.5)',
    70: 'rgba(209, 228, 244, 0.7)',
    75: 'rgba(209, 228, 244, 0.75)',
    80: 'rgba(209, 228, 244, 0.8)',
    85: 'rgba(209, 228, 244, 0.85)',
  },
  400: {
    5: 'rgba(51, 95, 112, 0.05)',
    7: 'rgba(51, 95, 112, 0.07)',
    8: 'rgba(51, 95, 112, 0.08)',
    25: 'rgba(51, 95, 112, 0.25)',
    30: 'rgba(51, 95, 112, 0.3)',
    35: 'rgba(51, 95, 112, 0.35)',
    40: 'rgba(51, 95, 112, 0.4)',
    50: 'rgba(51, 95, 112, 0.5)',
    60: 'rgba(51, 95, 112, 0.6)',
    70: 'rgba(51, 95, 112, 0.7)',
    90: 'rgba(51, 95, 112, 0.9)',
    95: 'rgba(51, 95, 112, 0.95)',
  },
  500: {
    5: 'rgba(59, 130, 246, 0.05)',
    8: 'rgba(59, 130, 246, 0.08)',
    10: 'rgba(59, 130, 246, 0.1)',
    15: 'rgba(59, 130, 246, 0.15)',
    18: 'rgba(59, 130, 246, 0.18)',
    25: 'rgba(59, 130, 246, 0.25)',
    30: 'rgba(59, 130, 246, 0.3)',
    40: 'rgba(59, 130, 246, 0.4)',
    60: 'rgba(59, 130, 246, 0.6)',
  },
  600: {
    4: 'rgba(10, 61, 80, 0.04)',
    20: 'rgba(10, 61, 80, 0.2)',
  },
  650: {
    70: 'rgba(10, 34, 48, 0.7)',
    85: 'rgba(10, 34, 48, 0.85)',
  },
  700: {
    3: 'rgba(42, 65, 89, 0.03)',
  },
  800: {
    1: 'rgba(11, 107, 203, 0.01)',
    2: 'rgba(11, 107, 203, 0.02)',
    5: 'rgba(11, 107, 203, 0.05)',
    8: 'rgba(11, 107, 203, 0.08)',
    10: 'rgba(11, 107, 203, 0.1)',
    12: 'rgba(11, 107, 203, 0.12)',
    15: 'rgba(11, 107, 203, 0.15)',
    20: 'rgba(11, 107, 203, 0.2)',
    25: 'rgba(11, 107, 203, 0.25)',
    50: 'rgba(11, 107, 203, 0.5)',
  },
} as const;

/** Translucent variants of the gray ramp (and fixed one-off bases), as rgba() strings. */
export const grayAlpha = {
  0: {
    20: 'rgba(255, 255, 255, 0.2)',
    50: 'rgba(255, 255, 255, 0.5)',
  },
  5: {
    98: 'rgba(241, 245, 249, 0.98)',
  },
  15: {
    90: 'rgba(248, 250, 252, 0.9)',
    95: 'rgba(248, 250, 252, 0.95)',
    96: 'rgba(248, 250, 252, 0.96)',
  },
  150: {
    10: 'rgba(190, 209, 223, 0.1)',
    20: 'rgba(190, 209, 223, 0.2)',
    30: 'rgba(190, 209, 223, 0.3)',
    50: 'rgba(190, 209, 223, 0.5)',
    80: 'rgba(190, 209, 223, 0.8)',
  },
  160: {
    50: 'rgba(201, 203, 205, 0.5)',
  },
  175: {
    12: 'rgba(224, 224, 224, 0.12)',
  },
  200: {
    20: 'rgba(211, 223, 232, 0.2)',
    50: 'rgba(211, 223, 232, 0.5)',
    60: 'rgba(211, 223, 232, 0.6)',
  },
  210: {
    50: 'rgba(211, 228, 244, 0.5)',
  },
  600: {
    3: 'rgba(115, 123, 130, 0.03)',
  },
  668: {
    16: 'rgba(128, 128, 128, 0.16)',
  },
  670: {
    16: 'rgba(136, 136, 136, 0.16)',
  },
  690: {
    15: 'rgba(107, 114, 128, 0.15)',
    40: 'rgba(107, 114, 128, 0.4)',
  },
  700: {
    50: 'rgba(48, 54, 58, 0.5)',
  },
  710: {
    50: 'rgba(50, 56, 62, 0.5)',
  },
  725: {
    30: 'rgba(55, 65, 81, 0.3)',
    50: 'rgba(55, 65, 81, 0.5)',
  },
  775: {
    25: 'rgba(42, 44, 56, 0.25)',
    30: 'rgba(42, 44, 56, 0.3)',
    50: 'rgba(42, 44, 56, 0.5)',
    60: 'rgba(42, 44, 56, 0.6)',
    70: 'rgba(42, 44, 56, 0.7)',
  },
  780: {
    72: 'rgba(30, 41, 59, 0.72)',
  },
  800: {
    8: 'rgba(44, 49, 53, 0.08)',
    50: 'rgba(44, 49, 53, 0.5)',
  },
  875: {
    50: 'rgba(16, 17, 17, 0.5)',
  },
} as const;

/** Translucent variants of the green ramp (and fixed one-off bases), as rgba() strings. */
export const greenAlpha = {
  375: {
    15: 'rgba(52, 211, 153, 0.15)',
    22: 'rgba(52, 211, 153, 0.22)',
    28: 'rgba(52, 211, 153, 0.28)',
  },
  400: {
    40: 'rgba(16, 185, 129, 0.4)',
  },
  500: {
    2: 'rgba(34, 197, 94, 0.02)',
    15: 'rgba(34, 197, 94, 0.15)',
  },
  600: {
    12: 'rgba(76, 175, 80, 0.12)',
  },
  800: {
    2: 'rgba(31, 184, 75, 0.02)',
    4: 'rgba(31, 184, 75, 0.04)',
    5: 'rgba(31, 184, 75, 0.05)',
    6: 'rgba(31, 184, 75, 0.06)',
    8: 'rgba(31, 184, 75, 0.08)',
    10: 'rgba(31, 184, 75, 0.1)',
    15: 'rgba(31, 184, 75, 0.15)',
    20: 'rgba(31, 184, 75, 0.2)',
    30: 'rgba(31, 184, 75, 0.3)',
    50: 'rgba(31, 184, 75, 0.5)',
  },
  900: {
    5: 'rgba(30, 122, 32, 0.05)',
  },
  950: {
    20: 'rgba(22, 114, 48, 0.2)',
    40: 'rgba(22, 114, 48, 0.4)',
  },
} as const;

/** Translucent variants of the teal ramp (and fixed one-off bases), as rgba() strings. */
export const tealAlpha = {
  custom: {
    5: 'rgba(92, 184, 166, 0.05)',
  },
} as const;

/** Translucent variants of the white ramp (and fixed one-off bases), as rgba() strings. */
export const whiteAlpha = {
  0: {
    5: 'rgba(255, 255, 255, 0.05)',
    10: 'rgba(255, 255, 255, 0.1)',
    12: 'rgba(255, 255, 255, 0.12)',
    20: 'rgba(255, 255, 255, 0.2)',
    30: 'rgba(255, 255, 255, 0.3)',
    50: 'rgba(255, 255, 255, 0.5)',
    70: 'rgba(255, 255, 255, 0.7)',
    80: 'rgba(255, 255, 255, 0.8)',
    90: 'rgba(255, 255, 255, 0.9)',
    95: 'rgba(255, 255, 255, 0.95)',
    96: 'rgba(255, 255, 255, 0.96)',
    98: 'rgba(255, 255, 255, 0.98)',
  },
} as const;

/** Translucent variants of the black ramp (and fixed one-off bases), as rgba() strings. */
export const blackAlpha = {
  0: {
    1: 'rgba(0, 0, 0, 0.01)',
    2: 'rgba(0, 0, 0, 0.02)',
    3: 'rgba(0, 0, 0, 0.03)',
    4: 'rgba(0, 0, 0, 0.04)',
    5: 'rgba(0, 0, 0, 0.05)',
    6: 'rgba(0, 0, 0, 0.06)',
    8: 'rgba(0, 0, 0, 0.08)',
    10: 'rgba(0, 0, 0, 0.1)',
    12: 'rgba(0, 0, 0, 0.12)',
    15: 'rgba(0, 0, 0, 0.15)',
    18: 'rgba(0, 0, 0, 0.18)',
    20: 'rgba(0, 0, 0, 0.2)',
    25: 'rgba(0, 0, 0, 0.25)',
    30: 'rgba(0, 0, 0, 0.3)',
    50: 'rgba(0, 0, 0, 0.5)',
  },
} as const;

/** Translucent variants of the red ramp (and fixed one-off bases), as rgba() strings. */
export const redAlpha = {
  325: {
    8: 'rgba(234, 61, 61, 0.08)',
    50: 'rgba(234, 61, 61, 0.5)',
  },
  400: {
    15: 'rgba(239, 68, 68, 0.15)',
    22: 'rgba(239, 68, 68, 0.22)',
    28: 'rgba(239, 68, 68, 0.28)',
    40: 'rgba(239, 68, 68, 0.4)',
  },
  450: {
    10: 'rgba(255, 107, 107, 0.1)',
  },
  600: {
    10: 'rgba(218, 49, 49, 0.1)',
    20: 'rgba(218, 49, 49, 0.2)',
  },
} as const;

/** Translucent variants of the purple ramp (and fixed one-off bases), as rgba() strings. */
export const purpleAlpha = {
  325: {
    20: 'rgba(165, 180, 252, 0.2)',
  },
  500: {
    2: 'rgba(139, 92, 246, 0.02)',
    5: 'rgba(139, 92, 246, 0.05)',
    8: 'rgba(139, 92, 246, 0.08)',
    15: 'rgba(139, 92, 246, 0.15)',
    40: 'rgba(139, 92, 246, 0.4)',
  },
  550: {
    5: 'rgba(147, 51, 234, 0.05)',
    8: 'rgba(147, 51, 234, 0.08)',
  },
} as const;

/** Translucent variants of the orange ramp (and fixed one-off bases), as rgba() strings. */
export const orangeAlpha = {
  350: {
    10: 'rgba(255, 172, 88, 0.1)',
  },
  375: {
    2: 'rgba(251, 146, 60, 0.02)',
    15: 'rgba(251, 146, 60, 0.15)',
    22: 'rgba(251, 146, 60, 0.22)',
    28: 'rgba(251, 146, 60, 0.28)',
  },
  450: {
    15: 'rgba(255, 165, 0, 0.15)',
    22: 'rgba(255, 165, 0, 0.22)',
    28: 'rgba(255, 165, 0, 0.28)',
  },
  550: {
    15: 'rgba(245, 158, 11, 0.15)',
    40: 'rgba(245, 158, 11, 0.4)',
  },
} as const;

/** Translucent variants of the cyan ramp (and fixed one-off bases), as rgba() strings. */
export const cyanAlpha = {
  400: {
    40: 'rgba(6, 182, 212, 0.4)',
  },
  600: {
    70: 'rgba(0, 255, 255, 0.7)',
  },
} as const;

/** Translucent variants of the pink ramp (and fixed one-off bases), as rgba() strings. */
export const pinkAlpha = {
  400: {
    40: 'rgba(236, 72, 153, 0.4)',
  },
} as const;

/** Translucent variants of the blue ramp (and fixed one-off bases), as rgba() strings. */
export const blueAlpha = {
  650: {
    2: 'rgba(13, 110, 253, 0.02)',
    15: 'rgba(13, 110, 253, 0.15)',
    25: 'rgba(13, 110, 253, 0.25)',
    50: 'rgba(13, 110, 253, 0.5)',
    75: 'rgba(13, 110, 253, 0.75)',
  },
} as const;

/** Translucent variants of the gold ramp (and fixed one-off bases), as rgba() strings. */
export const goldAlpha = {
  400: {
    10: 'rgba(255, 215, 0, 0.1)',
    20: 'rgba(255, 215, 0, 0.2)',
    30: 'rgba(255, 215, 0, 0.3)',
    40: 'rgba(255, 215, 0, 0.4)',
    50: 'rgba(255, 215, 0, 0.5)',
    60: 'rgba(255, 215, 0, 0.6)',
    70: 'rgba(255, 215, 0, 0.7)',
    80: 'rgba(255, 215, 0, 0.8)',
    90: 'rgba(255, 215, 0, 0.9)',
    100: '#ffd700',
  },
} as const;

/** Single-purpose colors that belong to no ramp. */
export const unique = {
  softHoverColor: '#E3EFFB',
  solidDisabledColor: '#32383E',
  scrollbar: '#AEBFC7',
  lightBlue: '#ADD8E6',
  limeGreen: '#4CBB17',
  mediumGray: '#A0A0A0',
  tealPreview: '#5CB8A6',
  almostBlack: '#040506',
  lightBlueOverlay: '#F5FAFF',
  lightGrayBackground: '#F5F5F5',
};

/** Every color primitive, grouped for schema validation and emitters. */
export const colorPrimitives = {
  ramps: { brand, gray, green, red, orange, blue, teal, purple, cyan, pink, gold },
  alphas: {
    brand: brandAlpha,
    gray: grayAlpha,
    green: greenAlpha,
    teal: tealAlpha,
    white: whiteAlpha,
    black: blackAlpha,
    red: redAlpha,
    purple: purpleAlpha,
    orange: orangeAlpha,
    cyan: cyanAlpha,
    pink: pinkAlpha,
    blue: blueAlpha,
    gold: goldAlpha,
  },
  unique,
};
