import type { ImageOutputFormat, OpenAIImageQuality, OpenAIImageStyle } from '../schemas/openai';
import type { ImageSizing } from '../utils/imageCapabilities';
import { parseSizeEdges, satisfiesGptImage2Constraints } from '../utils/imageSizes';
import {
  IMAGE_INPUT_ROLES,
  type AspectRatioCapability,
  type ImageInputRole,
  type ImageMode,
  type ImageModeCapabilities,
  type ImageModelCatalogEntry,
} from './types';

/**
 * The capability-relevant part of an image request. Inputs carry only their role so any request shape that
 * role-tags its inputs (a job payload, an API body) can be checked as-is. Every field but `mode` is optional:
 * absent means the provider default.
 */
export type ImageCapabilityRequest = {
  mode: ImageMode;
  inputs?: ReadonlyArray<{ role: ImageInputRole }>;
  size?: string;
  aspectRatio?: string;
  quality?: OpenAIImageQuality;
  style?: OpenAIImageStyle;
  outputFormat?: ImageOutputFormat;
  // Images to render.
  count?: number;
  transparentBackground?: boolean;
  seed?: number;
};

export type ImageRequestField = keyof ImageCapabilityRequest;

export const IMAGE_VALIDATION_ERROR_CODES = [
  'unsupported_mode',
  'missing_input',
  'unexpected_input',
  'unsupported_input_role',
  'too_many_inputs',
  'unsupported_size',
  'unsupported_aspect_ratio',
  'unsupported_quality',
  'unsupported_style',
  'unsupported_output_format',
  'unsupported_output_count',
  'unsupported_transparent_background',
  'unsupported_seed',
] as const;
export type ImageValidationErrorCode = (typeof IMAGE_VALIDATION_ERROR_CODES)[number];

// `field` names the request field at fault so a per-field reason can be attached; `role` narrows an inputs failure.
export type ImageValidationFailure = {
  code: ImageValidationErrorCode;
  field: ImageRequestField;
  role?: ImageInputRole;
  message: string;
};

export type ImageValidationResult<T extends ImageCapabilityRequest = ImageCapabilityRequest> =
  { ok: true; request: T } | { ok: false; failures: [ImageValidationFailure, ...ImageValidationFailure[]] };

const EDIT_ONLY_ROLES = new Set<ImageInputRole>(['edit_source', 'mask']);
// Formats with an alpha channel; the request path silently promotes jpeg to png when transparency is asked for.
const ALPHA_FORMATS = new Set<ImageOutputFormat>(['png', 'webp']);
const RATIO_PATTERN = /^(\d+):(\d+)$/;

const parseRatio = (ratio: string): number | null => {
  const match = RATIO_PATTERN.exec(ratio);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width && height ? width / height : null;
};

const listOrNone = (values: readonly string[]): string => (values.length > 0 ? values.join(', ') : 'none');

function checkInputs(request: ImageCapabilityRequest, modeCaps: ImageModeCapabilities): ImageValidationFailure[] {
  const inputs = request.inputs ?? [];
  const failures: ImageValidationFailure[] = [];
  for (const role of IMAGE_INPUT_ROLES) {
    const count = inputs.filter(input => input.role === role).length;
    const accepted = modeCaps.inputs[role];
    const isRequired = request.mode === 'edit' && (role === 'edit_source' || accepted?.required === true);
    if (count === 0) {
      if (isRequired)
        failures.push({ code: 'missing_input', field: 'inputs', role, message: `edit requires a ${role} input` });
      continue;
    }
    if (request.mode === 'generate' && EDIT_ONLY_ROLES.has(role)) {
      failures.push({
        code: 'unexpected_input',
        field: 'inputs',
        role,
        message: `a ${role} input is only valid for edit`,
      });
      continue;
    }
    if (!accepted) {
      failures.push({
        code: 'unsupported_input_role',
        field: 'inputs',
        role,
        message: `${role} inputs are not supported`,
      });
      continue;
    }
    if (count > accepted.max) {
      failures.push({
        code: 'too_many_inputs',
        field: 'inputs',
        role,
        message: `at most ${accepted.max} ${role} input(s)`,
      });
    }
  }
  return failures;
}

function isSizeAllowed(size: string, sizing: ImageSizing): boolean {
  switch (sizing.kind) {
    case 'presets':
      return sizing.presets.includes(size);
    case 'constrained': {
      if (sizing.presets.includes(size) || size === sizing.autoSize) return true;
      const edges = parseSizeEdges(size);
      return edges !== null && satisfiesGptImage2Constraints(edges);
    }
    case 'dimensions': {
      // Presets pass as declared, though resolveImageDimensions snaps the off-step ones (1440x810, 800x600,
      // 600x800) to the grid. A custom size must already be on it.
      if (sizing.presets.includes(size)) return true;
      const edges = parseSizeEdges(size);
      if (!edges) return false;
      const { width, height } = edges;
      return (
        width >= sizing.minWidth &&
        width <= sizing.maxWidth &&
        height >= sizing.minHeight &&
        height <= sizing.maxHeight &&
        width % sizing.step === 0 &&
        height % sizing.step === 0
      );
    }
    case 'aspectRatio':
    case 'inputImage':
    case 'fixed':
      return false;
  }
}

function describeSizing(sizing: ImageSizing): string {
  switch (sizing.kind) {
    case 'presets':
      return `allowed: ${sizing.presets.join(', ')}`;
    case 'constrained':
      return `allowed: ${sizing.autoSize}, a preset, or a custom size within the model's limits`;
    case 'dimensions':
      return `allowed: ${sizing.minWidth}-${sizing.maxWidth} x ${sizing.minHeight}-${sizing.maxHeight} in ${sizing.step}px steps`;
    case 'aspectRatio':
      return 'it takes an aspect ratio instead';
    case 'inputImage':
      return 'it takes the size of its input image';
    case 'fixed':
      return 'it takes no size';
  }
}

function isAspectRatioAllowed(ratio: string, aspectRatios: AspectRatioCapability): boolean {
  if (aspectRatios.kind === 'discrete') return aspectRatios.values.includes(ratio);
  const value = parseRatio(ratio);
  const tallest = parseRatio(aspectRatios.tallest);
  const widest = parseRatio(aspectRatios.widest);
  return value !== null && tallest !== null && widest !== null && value >= tallest && value <= widest;
}

const describeAspectRatios = (aspectRatios: AspectRatioCapability): string =>
  aspectRatios.kind === 'discrete'
    ? `allowed: ${aspectRatios.values.join(', ')}`
    : `allowed: ${aspectRatios.tallest} to ${aspectRatios.widest}`;

function checkModeOutput(
  request: ImageCapabilityRequest,
  caps: ImageModelCatalogEntry,
  modeCaps: ImageModeCapabilities
): ImageValidationFailure[] {
  const failures: ImageValidationFailure[] = [];
  const { aspectRatio, outputFormat, count, transparentBackground } = request;
  const { aspectRatios, outputFormats, maxOutputs } = modeCaps;
  if (aspectRatio !== undefined && !(aspectRatios && isAspectRatioAllowed(aspectRatio, aspectRatios))) {
    failures.push({
      code: 'unsupported_aspect_ratio',
      field: 'aspectRatio',
      message: aspectRatios
        ? `aspect ratio ${aspectRatio} is not supported (${describeAspectRatios(aspectRatios)})`
        : `aspect ratio is not supported for ${request.mode}`,
    });
  }
  if (outputFormat !== undefined && !outputFormats.includes(outputFormat)) {
    failures.push({
      code: 'unsupported_output_format',
      field: 'outputFormat',
      message: `output format ${outputFormat} is not supported (allowed: ${listOrNone(outputFormats)})`,
    });
  } else if (
    transparentBackground &&
    caps.transparentBackground &&
    outputFormat !== undefined &&
    !ALPHA_FORMATS.has(outputFormat)
  ) {
    failures.push({
      code: 'unsupported_output_format',
      field: 'outputFormat',
      message: `output format ${outputFormat} cannot carry a transparent background`,
    });
  }
  if (count !== undefined && (!Number.isInteger(count) || count < 1 || count > maxOutputs)) {
    failures.push({
      code: 'unsupported_output_count',
      field: 'count',
      message: `${count} images per request is not supported for ${request.mode} (allowed: 1-${maxOutputs})`,
    });
  }
  return failures;
}

function checkModelParams(request: ImageCapabilityRequest, caps: ImageModelCatalogEntry): ImageValidationFailure[] {
  const failures: ImageValidationFailure[] = [];
  const { size, quality, style, transparentBackground, seed } = request;
  if (size !== undefined && !isSizeAllowed(size, caps.sizing)) {
    failures.push({
      code: 'unsupported_size',
      field: 'size',
      message: `size ${size} is not supported (${describeSizing(caps.sizing)})`,
    });
  }
  if (quality !== undefined && !caps.qualities.includes(quality)) {
    failures.push({
      code: 'unsupported_quality',
      field: 'quality',
      message: `quality ${quality} is not supported (allowed: ${listOrNone(caps.qualities)})`,
    });
  }
  if (style !== undefined && !caps.styles.includes(style)) {
    failures.push({
      code: 'unsupported_style',
      field: 'style',
      message: `style ${style} is not supported (allowed: ${listOrNone(caps.styles)})`,
    });
  }
  if (transparentBackground && !caps.transparentBackground) {
    failures.push({
      code: 'unsupported_transparent_background',
      field: 'transparentBackground',
      message: 'transparent background is not supported',
    });
  }
  if (seed !== undefined && !caps.seed) {
    failures.push({ code: 'unsupported_seed', field: 'seed', message: 'a seed is not supported' });
  }
  return failures;
}

/**
 * Checks a request against one model's declared capabilities and reports every field it cannot honour, so a
 * caller can explain each disabled option. Never rounds, clamps or swaps the model. On an unsupported mode
 * the mode-scoped fields (inputs, aspect ratio, format, count) are not checked, since no mode limits apply.
 */
export function validateImageRequest<T extends ImageCapabilityRequest>(
  request: T,
  caps: ImageModelCatalogEntry
): ImageValidationResult<T> {
  const modeCaps = caps.modes[request.mode];
  const failures: ImageValidationFailure[] = modeCaps
    ? [...checkInputs(request, modeCaps), ...checkModeOutput(request, caps, modeCaps)]
    : [
        {
          code: 'unsupported_mode',
          field: 'mode',
          message: `${request.mode} is not supported (allowed: ${listOrNone(Object.keys(caps.modes))})`,
        },
      ];
  failures.push(...checkModelParams(request, caps));
  const [first, ...rest] = failures;
  return first ? { ok: false, failures: [first, ...rest] } : { ok: true, request };
}
