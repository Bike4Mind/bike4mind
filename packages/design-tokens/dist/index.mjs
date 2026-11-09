import { z } from "zod";
//#region src/schema.ts
/** #RGB, #RGBA, #RRGGBB or #RRGGBBAA. */
const hexColorSchema = z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, "expected a hex color");
/** rgb()/rgba() in the exact "rgba(r, g, b, a)" shape the token data uses. */
const rgbaColorSchema = z.string().regex(/^rgba?\(\d{1,3}, \d{1,3}, \d{1,3}(?:, (?:0|1|0?\.\d+))?\)$/, "expected an rgb()/rgba() color");
/**
* A reference to another token by dotted path (e.g. "neutral.200"), resolved
* by the consuming platform's palette. Used sparingly; prefer literal colors.
*/
const tokenReferenceSchema = z.string().regex(/^[a-z][a-zA-Z]*\.[a-zA-Z0-9]+$/, "expected a dotted token reference");
const colorValueSchema = z.union([
	hexColorSchema,
	rgbaColorSchema,
	tokenReferenceSchema
]);
/** Compound CSS values (border shorthands, gradients). Web-oriented escape hatch. */
const cssValueSchema = z.string().min(1);
/** A color ramp: numeric stop -> color. */
const colorRampSchema = z.record(z.string().regex(/^\d+$/), hexColorSchema);
/** Alpha variants: base stop -> opacity percent -> translucent color. */
const alphaRampSchema = z.record(z.string(), z.record(z.string().regex(/^\d+$/), z.union([rgbaColorSchema, hexColorSchema])));
const colorPrimitivesSchema = z.strictObject({
	ramps: z.record(z.string(), colorRampSchema),
	alphas: z.record(z.string(), alphaRampSchema),
	unique: z.record(z.string(), hexColorSchema)
});
/**
* Interaction tones for one intent (accent, neutral, success, danger,
* warning). Every field is optional: each mode overrides only the tones the
* design actually specifies, and emitters must emit exactly the defined keys
* so the platform defaults keep covering the rest.
*/
const interactionTonesSchema = z.strictObject({
	solidBackground: colorValueSchema.optional(),
	solidText: colorValueSchema.optional(),
	solidHoverBackground: colorValueSchema.optional(),
	solidActiveBackground: colorValueSchema.optional(),
	solidDisabledBackground: colorValueSchema.optional(),
	solidDisabledText: colorValueSchema.optional(),
	solidBorder: cssValueSchema.optional(),
	outlinedText: colorValueSchema.optional(),
	outlinedBorder: colorValueSchema.optional(),
	outlinedHoverBackground: colorValueSchema.optional(),
	subtleBackground: colorValueSchema.optional(),
	subtleText: colorValueSchema.optional(),
	subtleHoverBackground: colorValueSchema.optional(),
	subtleHoverText: colorValueSchema.optional(),
	subtleActiveBackground: colorValueSchema.optional(),
	subtleActiveText: colorValueSchema.optional(),
	plainActiveBackground: colorValueSchema.optional(),
	/** The intent's main channel color, for derived uses (charts, badges). */
	main: colorValueSchema.optional()
});
/** One mode (light or dark) of the semantic color scheme. */
const semanticColorSchemeSchema = z.strictObject({
	divider: colorValueSchema,
	text: z.strictObject({
		primary: colorValueSchema,
		secondary: colorValueSchema,
		tertiary: colorValueSchema,
		icon: colorValueSchema,
		navLinks: colorValueSchema,
		primary50: colorValueSchema,
		primary70: colorValueSchema
	}),
	border: z.strictObject({
		light: colorValueSchema,
		solid: colorValueSchema,
		input: colorValueSchema,
		muted: colorValueSchema,
		soft: colorValueSchema
	}),
	background: z.strictObject({
		body: colorValueSchema,
		surface: colorValueSchema,
		surface2: colorValueSchema,
		panel: colorValueSchema,
		panel2: colorValueSchema,
		sidebarItem: colorValueSchema,
		scrollbar: colorValueSchema,
		scrollbarTrack: colorValueSchema
	}),
	accent: interactionTonesSchema,
	neutral: interactionTonesSchema,
	success: interactionTonesSchema,
	danger: interactionTonesSchema,
	warning: interactionTonesSchema,
	feedback: z.strictObject({
		background: colorValueSchema,
		border: cssValueSchema,
		bug: colorValueSchema,
		feedback: colorValueSchema,
		positive: colorValueSchema,
		thumbsDown: colorValueSchema
	}),
	promptEnhancement: z.strictObject({
		background: colorValueSchema,
		backgroundHover: colorValueSchema,
		border: colorValueSchema,
		iconColor: colorValueSchema,
		textColor: colorValueSchema,
		chipBackground: colorValueSchema,
		chipColor: colorValueSchema,
		chipBorder: colorValueSchema,
		enhancedPromptBackground: colorValueSchema,
		enhancedPromptBorder: colorValueSchema
	})
});
const typographySchema = z.strictObject({
	fontFamily: z.strictObject({
		body: z.string().min(1),
		display: z.string().min(1)
	}),
	/** rem-based size ramp. */
	fontSize: z.record(z.string(), z.string().regex(/^[\d.]+rem$/)),
	fontWeight: z.record(z.string(), z.number().int().min(100).max(1e3)),
	/** Unitless line heights, as strings to preserve exact precision. */
	lineHeight: z.record(z.string(), z.string().regex(/^[\d.]+$/))
});
const spacingSchema = z.strictObject({ 
/** Base spacing unit in px; spacing steps are integer multiples of it. */
unit: z.number().positive() });
const radiiSchema = z.strictObject({
	xs: z.number().nonnegative(),
	sm: z.number().nonnegative(),
	md: z.number().nonnegative(),
	lg: z.number().nonnegative(),
	xl: z.number().nonnegative()
});
const shadowLayerSchema = z.strictObject({
	offsetX: z.number(),
	offsetY: z.number(),
	blur: z.number().nonnegative(),
	spread: z.number()
});
const shadowsSchema = z.strictObject({
	/** Shadow color as an "r g b" channel plus opacity, shared by all levels. */
	channel: z.string().regex(/^\d{1,3} \d{1,3} \d{1,3}$/),
	opacity: z.number().min(0).max(1),
	levels: z.strictObject({
		xs: z.array(shadowLayerSchema).min(1),
		sm: z.array(shadowLayerSchema).min(1),
		md: z.array(shadowLayerSchema).min(1),
		lg: z.array(shadowLayerSchema).min(1),
		xl: z.array(shadowLayerSchema).min(1)
	})
});
const motionSchema = z.strictObject({ 
/** Durations in milliseconds. */
duration: z.strictObject({
	fast: z.number().positive(),
	standard: z.number().positive(),
	slow: z.number().positive(),
	slower: z.number().positive()
}) });
const designTokensSchema = z.strictObject({
	color: z.strictObject({
		primitives: colorPrimitivesSchema,
		schemes: z.strictObject({
			light: semanticColorSchemeSchema,
			dark: semanticColorSchemeSchema
		})
	}),
	typography: typographySchema,
	spacing: spacingSchema,
	radii: radiiSchema,
	shadows: shadowsSchema,
	motion: motionSchema
});
//#endregion
//#region src/tokens/primitives.ts
/** Brand color ramp: the primary blue tones used throughout the product. */
const brand = {
	100: "#D1E4F4",
	400: "#335F70",
	500: "#3b82f6",
	600: "#0A3D50",
	650: "#0A2230",
	700: "#2A4159",
	800: "#0B6BCB",
	900: "#0959AA"
};
/** Neutral ramp for backgrounds, borders and text. */
const gray = {
	0: "#FFFFFF",
	5: "#f1f5f9",
	8: "#f3f4f6",
	10: "#FBFCFE",
	12: "#F0F3F5",
	15: "#f8fafc",
	25: "#F7F9FB",
	50: "#F4F7F9",
	55: "#E8F4F8",
	75: "#E2ECF4",
	100: "#DDE7EE",
	150: "#BED1DF",
	155: "#f1f1f1",
	160: "#C9CBCD",
	175: "#E0E0E0",
	185: "#E8EAED",
	188: "#e2e8f0",
	190: "#E5E7EB",
	200: "#D3DFE8",
	210: "#D3E4F4",
	220: "#abb2bf",
	600: "#737B82",
	650: "#636B74",
	653: "#555555",
	655: "#5a5a5a",
	660: "#4a4a4a",
	665: "#666",
	668: "#808080",
	670: "#888888",
	680: "#64748b",
	685: "#9ca3af",
	690: "#6b7280",
	700: "#30363A",
	710: "#32383E",
	720: "#4b5563",
	725: "#374151",
	730: "#444444",
	740: "#282c34",
	750: "#475569",
	775: "#2A2C38",
	780: "#1e293b",
	800: "#2C3135",
	825: "#14191D",
	830: "#1e1e1e",
	845: "#131C1C",
	850: "#13181C",
	860: "#1f2937",
	865: "#1A2332",
	870: "#111827",
	875: "#101111",
	900: "#0E1214",
	925: "#0D0F10"
};
/** Success states and positive feedback. */
const green = {
	375: "#34d399",
	400: "#10b981",
	450: "#4ade80",
	500: "#22C55E",
	550: "#16a34a",
	600: "#4CAF50",
	650: "#059669",
	800: "#1FB84B",
	850: "#1FB94B",
	875: "#1a9d3f",
	900: "#1E7A20",
	925: "#1F7A1F",
	950: "#167230",
	975: "#1a3a1f"
};
/** Error states and critical alerts. */
const red = {
	250: "#ffebee",
	300: "#F09898",
	325: "#EA3D3D",
	330: "#d32f2f",
	375: "#f87171",
	400: "#ef4444",
	450: "#FF6B6B",
	500: "#E64A4A",
	550: "#dc2626",
	600: "#DA3131",
	700: "#C41C1C"
};
/** Warning states and attention-grabbing elements. */
const orange = {
	300: "#FFA726",
	350: "#FFAC58",
	375: "#fb923c",
	400: "#E8845A",
	425: "#EA9A3D",
	430: "#f5a623",
	450: "#FFA500",
	500: "#F97316",
	550: "#f59e0b",
	600: "#EA580C",
	625: "#fbbf24",
	650: "#d97706"
};
/** Informational and interactive accents. */
const blue = {
	400: "#0ea5e9",
	500: "#4A90E2",
	550: "#61afef",
	600: "#0066C1",
	650: "#0d6efd",
	700: "#0284c7",
	750: "#1565c0",
	775: "#1976d2",
	800: "#2563eb"
};
/** Project and productivity accents. */
const teal = { 600: "#3A9D60" };
/** Agent and AI-related accents. */
const purple = {
	300: "#6366f1",
	325: "#a5b4fc",
	350: "#667eea",
	400: "#818cf8",
	500: "#8b5cf6",
	550: "#9333ea",
	600: "#9857B1",
	700: "#7c3aed",
	750: "#764ba2"
};
/** Bright informational accents. */
const cyan = {
	50: "#f0f9ff",
	100: "#e0f2fe",
	300: "#2AC6F9",
	400: "#06b6d4",
	500: "#0891b2",
	600: "#00ffff"
};
/** Highlight accents (gradients). */
const pink = {
	400: "#ec4899",
	500: "#db2777"
};
/** Premium highlight accents. */
const gold = { 400: "#ffd700" };
/** Translucent variants of the brand ramp (and fixed one-off bases), as rgba() strings. */
const brandAlpha = {
	100: {
		4: "rgba(209, 228, 244, 0.04)",
		5: "rgba(209, 228, 244, 0.05)",
		8: "rgba(209, 228, 244, 0.08)",
		12: "rgba(209, 228, 244, 0.12)",
		15: "rgba(209, 228, 244, 0.15)",
		20: "rgba(209, 228, 244, 0.2)",
		25: "rgba(209, 228, 244, 0.25)",
		30: "rgba(209, 228, 244, 0.3)",
		35: "rgba(209, 228, 244, 0.35)",
		50: "rgba(209, 228, 244, 0.5)",
		70: "rgba(209, 228, 244, 0.7)",
		75: "rgba(209, 228, 244, 0.75)",
		80: "rgba(209, 228, 244, 0.8)",
		85: "rgba(209, 228, 244, 0.85)"
	},
	400: {
		5: "rgba(51, 95, 112, 0.05)",
		7: "rgba(51, 95, 112, 0.07)",
		8: "rgba(51, 95, 112, 0.08)",
		25: "rgba(51, 95, 112, 0.25)",
		30: "rgba(51, 95, 112, 0.3)",
		35: "rgba(51, 95, 112, 0.35)",
		40: "rgba(51, 95, 112, 0.4)",
		50: "rgba(51, 95, 112, 0.5)",
		60: "rgba(51, 95, 112, 0.6)",
		70: "rgba(51, 95, 112, 0.7)",
		90: "rgba(51, 95, 112, 0.9)",
		95: "rgba(51, 95, 112, 0.95)"
	},
	500: {
		5: "rgba(59, 130, 246, 0.05)",
		8: "rgba(59, 130, 246, 0.08)",
		10: "rgba(59, 130, 246, 0.1)",
		15: "rgba(59, 130, 246, 0.15)",
		25: "rgba(59, 130, 246, 0.25)",
		30: "rgba(59, 130, 246, 0.3)",
		40: "rgba(59, 130, 246, 0.4)",
		60: "rgba(59, 130, 246, 0.6)"
	},
	600: {
		4: "rgba(10, 61, 80, 0.04)",
		20: "rgba(10, 61, 80, 0.2)"
	},
	650: {
		70: "rgba(10, 34, 48, 0.7)",
		85: "rgba(10, 34, 48, 0.85)"
	},
	700: { 3: "rgba(42, 65, 89, 0.03)" },
	800: {
		1: "rgba(11, 107, 203, 0.01)",
		2: "rgba(11, 107, 203, 0.02)",
		5: "rgba(11, 107, 203, 0.05)",
		8: "rgba(11, 107, 203, 0.08)",
		10: "rgba(11, 107, 203, 0.1)",
		12: "rgba(11, 107, 203, 0.12)",
		15: "rgba(11, 107, 203, 0.15)",
		20: "rgba(11, 107, 203, 0.2)",
		25: "rgba(11, 107, 203, 0.25)",
		50: "rgba(11, 107, 203, 0.5)"
	}
};
/** Translucent variants of the gray ramp (and fixed one-off bases), as rgba() strings. */
const grayAlpha = {
	0: {
		20: "rgba(255, 255, 255, 0.2)",
		50: "rgba(255, 255, 255, 0.5)"
	},
	5: { 98: "rgba(241, 245, 249, 0.98)" },
	15: {
		90: "rgba(248, 250, 252, 0.9)",
		95: "rgba(248, 250, 252, 0.95)",
		96: "rgba(248, 250, 252, 0.96)"
	},
	150: {
		10: "rgba(190, 209, 223, 0.1)",
		20: "rgba(190, 209, 223, 0.2)",
		30: "rgba(190, 209, 223, 0.3)",
		50: "rgba(190, 209, 223, 0.5)",
		80: "rgba(190, 209, 223, 0.8)"
	},
	160: { 50: "rgba(201, 203, 205, 0.5)" },
	175: { 12: "rgba(224, 224, 224, 0.12)" },
	200: {
		20: "rgba(211, 223, 232, 0.2)",
		50: "rgba(211, 223, 232, 0.5)",
		60: "rgba(211, 223, 232, 0.6)"
	},
	210: { 50: "rgba(211, 228, 244, 0.5)" },
	600: { 3: "rgba(115, 123, 130, 0.03)" },
	668: { 16: "rgba(128, 128, 128, 0.16)" },
	670: { 16: "rgba(136, 136, 136, 0.16)" },
	690: {
		15: "rgba(107, 114, 128, 0.15)",
		40: "rgba(107, 114, 128, 0.4)"
	},
	700: { 50: "rgba(48, 54, 58, 0.5)" },
	710: { 50: "rgba(50, 56, 62, 0.5)" },
	725: {
		30: "rgba(55, 65, 81, 0.3)",
		50: "rgba(55, 65, 81, 0.5)"
	},
	775: {
		25: "rgba(42, 44, 56, 0.25)",
		30: "rgba(42, 44, 56, 0.3)",
		50: "rgba(42, 44, 56, 0.5)",
		60: "rgba(42, 44, 56, 0.6)",
		70: "rgba(42, 44, 56, 0.7)"
	},
	780: { 72: "rgba(30, 41, 59, 0.72)" },
	800: {
		8: "rgba(44, 49, 53, 0.08)",
		50: "rgba(44, 49, 53, 0.5)"
	},
	875: { 50: "rgba(16, 17, 17, 0.5)" }
};
/** Translucent variants of the green ramp (and fixed one-off bases), as rgba() strings. */
const greenAlpha = {
	375: {
		15: "rgba(52, 211, 153, 0.15)",
		22: "rgba(52, 211, 153, 0.22)",
		28: "rgba(52, 211, 153, 0.28)"
	},
	400: { 40: "rgba(16, 185, 129, 0.4)" },
	500: {
		2: "rgba(34, 197, 94, 0.02)",
		15: "rgba(34, 197, 94, 0.15)"
	},
	600: { 12: "rgba(76, 175, 80, 0.12)" },
	800: {
		2: "rgba(31, 184, 75, 0.02)",
		4: "rgba(31, 184, 75, 0.04)",
		5: "rgba(31, 184, 75, 0.05)",
		6: "rgba(31, 184, 75, 0.06)",
		8: "rgba(31, 184, 75, 0.08)",
		10: "rgba(31, 184, 75, 0.1)",
		15: "rgba(31, 184, 75, 0.15)",
		20: "rgba(31, 184, 75, 0.2)",
		30: "rgba(31, 184, 75, 0.3)",
		50: "rgba(31, 184, 75, 0.5)"
	},
	900: { 5: "rgba(30, 122, 32, 0.05)" },
	950: {
		20: "rgba(22, 114, 48, 0.2)",
		40: "rgba(22, 114, 48, 0.4)"
	}
};
/** Translucent variants of the teal ramp (and fixed one-off bases), as rgba() strings. */
const tealAlpha = { custom: { 5: "rgba(92, 184, 166, 0.05)" } };
/** Translucent variants of the white ramp (and fixed one-off bases), as rgba() strings. */
const whiteAlpha = { 0: {
	5: "rgba(255, 255, 255, 0.05)",
	10: "rgba(255, 255, 255, 0.1)",
	12: "rgba(255, 255, 255, 0.12)",
	20: "rgba(255, 255, 255, 0.2)",
	30: "rgba(255, 255, 255, 0.3)",
	50: "rgba(255, 255, 255, 0.5)",
	70: "rgba(255, 255, 255, 0.7)",
	80: "rgba(255, 255, 255, 0.8)",
	90: "rgba(255, 255, 255, 0.9)",
	95: "rgba(255, 255, 255, 0.95)",
	96: "rgba(255, 255, 255, 0.96)",
	98: "rgba(255, 255, 255, 0.98)"
} };
/** Translucent variants of the black ramp (and fixed one-off bases), as rgba() strings. */
const blackAlpha = { 0: {
	1: "rgba(0, 0, 0, 0.01)",
	2: "rgba(0, 0, 0, 0.02)",
	3: "rgba(0, 0, 0, 0.03)",
	4: "rgba(0, 0, 0, 0.04)",
	5: "rgba(0, 0, 0, 0.05)",
	6: "rgba(0, 0, 0, 0.06)",
	8: "rgba(0, 0, 0, 0.08)",
	10: "rgba(0, 0, 0, 0.1)",
	12: "rgba(0, 0, 0, 0.12)",
	15: "rgba(0, 0, 0, 0.15)",
	18: "rgba(0, 0, 0, 0.18)",
	20: "rgba(0, 0, 0, 0.2)",
	25: "rgba(0, 0, 0, 0.25)",
	30: "rgba(0, 0, 0, 0.3)",
	50: "rgba(0, 0, 0, 0.5)"
} };
/** Translucent variants of the red ramp (and fixed one-off bases), as rgba() strings. */
const redAlpha = {
	325: {
		8: "rgba(234, 61, 61, 0.08)",
		50: "rgba(234, 61, 61, 0.5)"
	},
	400: {
		15: "rgba(239, 68, 68, 0.15)",
		22: "rgba(239, 68, 68, 0.22)",
		28: "rgba(239, 68, 68, 0.28)",
		40: "rgba(239, 68, 68, 0.4)"
	},
	450: { 10: "rgba(255, 107, 107, 0.1)" },
	600: {
		10: "rgba(218, 49, 49, 0.1)",
		20: "rgba(218, 49, 49, 0.2)"
	}
};
/** Translucent variants of the purple ramp (and fixed one-off bases), as rgba() strings. */
const purpleAlpha = {
	325: { 20: "rgba(165, 180, 252, 0.2)" },
	500: {
		2: "rgba(139, 92, 246, 0.02)",
		5: "rgba(139, 92, 246, 0.05)",
		8: "rgba(139, 92, 246, 0.08)",
		15: "rgba(139, 92, 246, 0.15)",
		40: "rgba(139, 92, 246, 0.4)"
	},
	550: {
		5: "rgba(147, 51, 234, 0.05)",
		8: "rgba(147, 51, 234, 0.08)"
	}
};
/** Translucent variants of the orange ramp (and fixed one-off bases), as rgba() strings. */
const orangeAlpha = {
	350: { 10: "rgba(255, 172, 88, 0.1)" },
	375: {
		2: "rgba(251, 146, 60, 0.02)",
		15: "rgba(251, 146, 60, 0.15)",
		22: "rgba(251, 146, 60, 0.22)",
		28: "rgba(251, 146, 60, 0.28)"
	},
	450: {
		15: "rgba(255, 165, 0, 0.15)",
		22: "rgba(255, 165, 0, 0.22)",
		28: "rgba(255, 165, 0, 0.28)"
	},
	550: {
		15: "rgba(245, 158, 11, 0.15)",
		40: "rgba(245, 158, 11, 0.4)"
	}
};
/** Translucent variants of the cyan ramp (and fixed one-off bases), as rgba() strings. */
const cyanAlpha = {
	400: { 40: "rgba(6, 182, 212, 0.4)" },
	600: { 70: "rgba(0, 255, 255, 0.7)" }
};
/** Translucent variants of the pink ramp (and fixed one-off bases), as rgba() strings. */
const pinkAlpha = { 400: { 40: "rgba(236, 72, 153, 0.4)" } };
/** Translucent variants of the blue ramp (and fixed one-off bases), as rgba() strings. */
const blueAlpha = { 650: {
	2: "rgba(13, 110, 253, 0.02)",
	15: "rgba(13, 110, 253, 0.15)",
	25: "rgba(13, 110, 253, 0.25)",
	50: "rgba(13, 110, 253, 0.5)",
	75: "rgba(13, 110, 253, 0.75)"
} };
/** Translucent variants of the gold ramp (and fixed one-off bases), as rgba() strings. */
const goldAlpha = { 400: {
	10: "rgba(255, 215, 0, 0.1)",
	20: "rgba(255, 215, 0, 0.2)",
	30: "rgba(255, 215, 0, 0.3)",
	40: "rgba(255, 215, 0, 0.4)",
	50: "rgba(255, 215, 0, 0.5)",
	60: "rgba(255, 215, 0, 0.6)",
	70: "rgba(255, 215, 0, 0.7)",
	80: "rgba(255, 215, 0, 0.8)",
	90: "rgba(255, 215, 0, 0.9)",
	100: "#ffd700"
} };
/** Single-purpose colors that belong to no ramp. */
const unique = {
	softHoverColor: "#E3EFFB",
	solidDisabledColor: "#32383E",
	scrollbar: "#AEBFC7",
	lightBlue: "#ADD8E6",
	limeGreen: "#4CBB17",
	mediumGray: "#A0A0A0",
	tealPreview: "#5CB8A6",
	almostBlack: "#040506",
	lightBlueOverlay: "#F5FAFF",
	lightGrayBackground: "#F5F5F5"
};
/** Every color primitive, grouped for schema validation and emitters. */
const colorPrimitives = {
	ramps: {
		brand,
		gray,
		green,
		red,
		orange,
		blue,
		teal,
		purple,
		cyan,
		pink,
		gold
	},
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
		gold: goldAlpha
	},
	unique
};
//#endregion
//#region src/tokens/schemes.ts
const darkScheme = {
	divider: gray[800],
	text: {
		navLinks: cyan[300],
		icon: brandAlpha[100][50],
		primary: brand[100],
		primary50: brandAlpha[100][70],
		primary70: brandAlpha[100][80],
		secondary: brandAlpha[100][80],
		tertiary: brandAlpha[100][70]
	},
	border: {
		light: brandAlpha[100][15],
		solid: gray[800],
		input: gray[800],
		muted: grayAlpha[150][20],
		soft: brandAlpha[100][8]
	},
	background: {
		sidebarItem: grayAlpha[775][30],
		body: gray[900],
		scrollbar: brand[600],
		scrollbarTrack: gray[900],
		surface: gray[900],
		surface2: gray[850],
		panel: gray[850],
		panel2: gray[850]
	},
	accent: {
		subtleBackground: gray[850],
		subtleActiveBackground: brand[700],
		subtleHoverBackground: grayAlpha[775][70],
		subtleHoverText: unique.softHoverColor,
		solidDisabledBackground: gray[650],
		solidDisabledText: unique.solidDisabledColor,
		subtleText: gray[200]
	},
	success: {
		solidBackground: green[900],
		outlinedText: green[375],
		outlinedBorder: green[375],
		main: gray[200],
		subtleBackground: greenAlpha[375][15],
		subtleHoverBackground: greenAlpha[375][22],
		subtleActiveBackground: greenAlpha[375][28],
		subtleText: green[375]
	},
	danger: {
		solidBackground: red[600],
		solidHoverBackground: red[700],
		solidActiveBackground: red[700],
		outlinedText: red[400],
		outlinedBorder: red[400],
		subtleBackground: redAlpha[400][15],
		subtleHoverBackground: redAlpha[400][22],
		subtleActiveBackground: redAlpha[400][28],
		subtleText: red[375],
		main: red[400]
	},
	warning: {
		solidBackground: orange[450],
		solidText: "#000000",
		solidHoverBackground: orange[350],
		subtleBackground: orangeAlpha[450][15],
		subtleHoverBackground: orangeAlpha[450][22],
		subtleActiveBackground: orangeAlpha[450][28],
		subtleText: orange[450],
		outlinedText: orange[450],
		outlinedBorder: orange[450]
	},
	feedback: {
		background: gray[850],
		border: `1px solid ${gray[800]}`,
		bug: red[500],
		feedback: blue[500],
		positive: green[600],
		thumbsDown: orange[300]
	},
	neutral: {
		solidBackground: gray[850],
		solidText: gray[200],
		subtleText: gray[200],
		outlinedBorder: gray[800],
		outlinedHoverBackground: grayAlpha[775][70],
		plainActiveBackground: brand[700]
	},
	promptEnhancement: {
		background: brandAlpha[800][20],
		backgroundHover: brandAlpha[800][10],
		border: brandAlpha[800][20],
		iconColor: brand[100],
		textColor: brand[100],
		chipBackground: gray[800],
		chipColor: brand[100],
		chipBorder: gray[800],
		enhancedPromptBackground: tealAlpha.custom[5],
		enhancedPromptBorder: brandAlpha[800][25]
	}
};
const lightScheme = {
	text: {
		navLinks: brand[600],
		icon: brandAlpha[400][70],
		primary: brand[400],
		primary50: brandAlpha[400][90],
		primary70: brandAlpha[400][95],
		secondary: brandAlpha[400][95],
		tertiary: brandAlpha[400][90]
	},
	border: {
		light: gray[150],
		solid: gray[150],
		input: brand[100],
		muted: grayAlpha[150][20],
		soft: brandAlpha[100][50]
	},
	divider: gray[200],
	background: {
		sidebarItem: "neutral.200",
		body: gray[10],
		scrollbar: unique.scrollbar,
		scrollbarTrack: gray[50],
		surface: gray[50],
		surface2: gray[50],
		panel: gray[10],
		panel2: gray[0]
	},
	accent: {
		solidBackground: blue[600],
		solidText: gray[0],
		subtleBackground: gray[0],
		subtleActiveBackground: brand[100],
		subtleActiveText: brand[700],
		subtleHoverBackground: brandAlpha[100][30],
		subtleHoverText: brand[700],
		subtleText: brand[600]
	},
	success: {
		solidBackground: green[800],
		outlinedText: brand[600],
		main: brand[600]
	},
	danger: {
		solidBackground: red[600],
		solidHoverBackground: red[700],
		solidActiveBackground: red[700],
		outlinedText: red[600],
		outlinedBorder: red[600],
		subtleBackground: red[250],
		subtleText: red[600],
		main: red[600]
	},
	warning: {
		solidBackground: orange[450],
		solidText: "#000000",
		solidHoverBackground: orange[350],
		subtleBackground: orangeAlpha[450][22],
		subtleHoverBackground: orangeAlpha[450][22],
		subtleActiveBackground: orangeAlpha[450][28],
		subtleText: orange[450],
		outlinedText: orange[450],
		outlinedBorder: orange[450]
	},
	neutral: {
		solidBackground: gray[0],
		solidBorder: `2px solid ${brand[600]} !important`,
		solidText: brand[600],
		subtleText: brand[600],
		plainActiveBackground: brand[100]
	},
	feedback: {
		background: gray[50],
		border: `1px solid ${gray[200]}`,
		bug: red[500],
		feedback: blue[500],
		positive: green[600],
		thumbsDown: orange[300]
	},
	promptEnhancement: {
		background: unique.lightBlueOverlay,
		backgroundHover: brandAlpha[100][20],
		border: brand[100],
		iconColor: brand[600],
		textColor: brand[600],
		chipBackground: brandAlpha[100][50],
		chipColor: brand[600],
		chipBorder: gray[150],
		enhancedPromptBackground: brandAlpha[100][12],
		enhancedPromptBorder: gray[150]
	}
};
//#endregion
//#region src/tokens/typography.ts
const typography = {
	fontFamily: {
		body: "\"Libre Franklin\", -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, Helvetica, Arial, sans-serif",
		display: "\"Libre Franklin\", -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, Helvetica, Arial, sans-serif"
	},
	fontSize: {
		xs: "0.75rem",
		sm: "0.875rem",
		md: "1rem",
		lg: "1.125rem",
		xl: "1.25rem",
		xl2: "1.5rem",
		xl3: "1.875rem",
		xl4: "2.25rem"
	},
	fontWeight: {
		sm: 300,
		md: 500,
		lg: 600,
		xl: 700
	},
	lineHeight: {
		xs: "1.33334",
		sm: "1.42858",
		md: "1.5",
		lg: "1.55556",
		xl: "1.66667"
	}
};
//#endregion
//#region src/tokens/metrics.ts
const spacing = { unit: 8 };
const radii = {
	xs: 2,
	sm: 6,
	md: 8,
	lg: 12,
	xl: 16
};
const shadows = {
	channel: "21 21 21",
	opacity: .08,
	levels: {
		xs: [{
			offsetX: 0,
			offsetY: 1,
			blur: 2,
			spread: 0
		}],
		sm: [{
			offsetX: 0,
			offsetY: 1,
			blur: 2,
			spread: 0
		}, {
			offsetX: 0,
			offsetY: 2,
			blur: 4,
			spread: 0
		}],
		md: [{
			offsetX: 0,
			offsetY: 2,
			blur: 8,
			spread: -2
		}, {
			offsetX: 0,
			offsetY: 6,
			blur: 12,
			spread: -2
		}],
		lg: [{
			offsetX: 0,
			offsetY: 2,
			blur: 8,
			spread: -2
		}, {
			offsetX: 0,
			offsetY: 12,
			blur: 16,
			spread: -4
		}],
		xl: [{
			offsetX: 0,
			offsetY: 2,
			blur: 8,
			spread: -2
		}, {
			offsetX: 0,
			offsetY: 20,
			blur: 24,
			spread: -4
		}]
	}
};
const motion = { duration: {
	fast: 150,
	standard: 200,
	slow: 300,
	slower: 500
} };
//#endregion
//#region src/tokens/index.ts
/**
* The canonical token set, validated at module load so a malformed token
* fails fast at build/test time rather than rendering wrong.
*/
const designTokens = designTokensSchema.parse({
	color: {
		primitives: colorPrimitives,
		schemes: {
			light: lightScheme,
			dark: darkScheme
		}
	},
	typography,
	spacing,
	radii,
	shadows,
	motion
});
//#endregion
//#region src/emitters/cssVariables.ts
const isTokenReference = (value) => /^[a-z][a-zA-Z]*\.[a-zA-Z0-9]+$/.test(value);
const toKebab = (name) => name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
const collectSchemeVariables = (tokens, mode) => {
	const scheme = tokens.color.schemes[mode];
	const lines = [];
	const push = (path, value) => {
		if (isTokenReference(value)) return;
		lines.push(`  --b4m-color-${path.map(toKebab).join("-")}: ${value};`);
	};
	push(["divider"], scheme.divider);
	for (const [group, values] of Object.entries(scheme)) {
		if (typeof values === "string") continue;
		for (const [name, value] of Object.entries(values)) if (typeof value === "string") push([group, name], value);
	}
	return lines;
};
const shadowValue = (tokens, level) => tokens.shadows.levels[level].map((layer) => `${layer.offsetX}px ${layer.offsetY}px ${layer.blur}px ${layer.spread}px rgba(${tokens.shadows.channel} / ${tokens.shadows.opacity})`).join(", ");
const emitCssVariables = (tokens) => {
	const globalLines = [];
	for (const [name, value] of Object.entries(tokens.typography.fontFamily)) globalLines.push(`  --b4m-font-family-${toKebab(name)}: ${value};`);
	for (const [name, value] of Object.entries(tokens.typography.fontSize)) globalLines.push(`  --b4m-font-size-${toKebab(name)}: ${value};`);
	for (const [name, value] of Object.entries(tokens.typography.fontWeight)) globalLines.push(`  --b4m-font-weight-${toKebab(name)}: ${value};`);
	for (const [name, value] of Object.entries(tokens.typography.lineHeight)) globalLines.push(`  --b4m-line-height-${toKebab(name)}: ${value};`);
	globalLines.push(`  --b4m-spacing-unit: ${tokens.spacing.unit}px;`);
	for (const [name, value] of Object.entries(tokens.radii)) globalLines.push(`  --b4m-radius-${toKebab(name)}: ${value}px;`);
	for (const level of Object.keys(tokens.shadows.levels)) globalLines.push(`  --b4m-shadow-${level}: ${shadowValue(tokens, level)};`);
	for (const [name, value] of Object.entries(tokens.motion.duration)) globalLines.push(`  --b4m-duration-${toKebab(name)}: ${value}ms;`);
	return [
		":root {",
		...globalLines,
		...collectSchemeVariables(tokens, "light"),
		"}",
		"",
		"[data-b4m-color-scheme=\"dark\"] {",
		...collectSchemeVariables(tokens, "dark"),
		"}",
		""
	].join("\n");
};
const cssVariablesEmitter = {
	target: "css-variables",
	emit: emitCssVariables
};
//#endregion
//#region src/emitters/joy.ts
/** Semantic interaction-tone names -> Joy palette variant names. */
const TONE_TO_JOY = {
	solidBackground: "solidBg",
	solidText: "solidColor",
	solidHoverBackground: "solidHoverBg",
	solidActiveBackground: "solidActiveBg",
	solidDisabledBackground: "solidDisabledBg",
	solidDisabledText: "solidDisabledColor",
	solidBorder: "solidBorder",
	outlinedText: "outlinedColor",
	outlinedBorder: "outlinedBorder",
	outlinedHoverBackground: "outlinedHoverBg",
	subtleBackground: "softBg",
	subtleText: "softColor",
	subtleHoverBackground: "softHoverBg",
	subtleHoverText: "softHoverColor",
	subtleActiveBackground: "softActiveBg",
	subtleActiveText: "softActiveColor",
	plainActiveBackground: "plainActiveBg",
	main: "mainChannel"
};
const toJoyTones = (tones) => {
	const joyTones = {};
	for (const [semanticName, joyName] of Object.entries(TONE_TO_JOY)) {
		const value = tones[semanticName];
		if (value !== void 0) joyTones[joyName] = value;
	}
	return joyTones;
};
const toJoyPalette = (scheme) => ({
	divider: scheme.divider,
	text: { ...scheme.text },
	border: { ...scheme.border },
	background: { ...scheme.background },
	primary: toJoyTones(scheme.accent),
	neutral: toJoyTones(scheme.neutral),
	success: toJoyTones(scheme.success),
	danger: toJoyTones(scheme.danger),
	warning: toJoyTones(scheme.warning),
	feedback: { ...scheme.feedback },
	promptEnhancement: { ...scheme.promptEnhancement }
});
const emitJoyThemeFragment = (tokens) => ({
	colorSchemes: {
		light: { palette: toJoyPalette(tokens.color.schemes.light) },
		dark: { palette: toJoyPalette(tokens.color.schemes.dark) }
	},
	fontFamily: { ...tokens.typography.fontFamily },
	borderRadius: tokens.radii.md
});
const joyEmitter = {
	target: "joy",
	emit: emitJoyThemeFragment
};
//#endregion
//#region src/emitters/index.ts
/** Registry of the available emit targets, keyed by target name. */
const emitters = {
	[joyEmitter.target]: joyEmitter,
	[cssVariablesEmitter.target]: cssVariablesEmitter
};
//#endregion
export { alphaRampSchema, blackAlpha, blue, blueAlpha, brand, brandAlpha, colorPrimitives, colorPrimitivesSchema, colorRampSchema, colorValueSchema, cssValueSchema, cssVariablesEmitter, cyan, cyanAlpha, darkScheme, designTokens, designTokensSchema, emitCssVariables, emitJoyThemeFragment, emitters, gold, goldAlpha, gray, grayAlpha, green, greenAlpha, hexColorSchema, interactionTonesSchema, joyEmitter, lightScheme, motion, motionSchema, orange, orangeAlpha, pink, pinkAlpha, purple, purpleAlpha, radii, radiiSchema, red, redAlpha, rgbaColorSchema, semanticColorSchemeSchema, shadows, shadowsSchema, spacing, spacingSchema, teal, tealAlpha, tokenReferenceSchema, typography, typographySchema, unique, whiteAlpha };

//# sourceMappingURL=index.mjs.map