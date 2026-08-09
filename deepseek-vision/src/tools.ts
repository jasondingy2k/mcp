// tools.ts — 8 个工具注册 + 8 个 PROMPTS（能力=工具名，来源=source 参数）
// 描述/指令统一英文（面向 agent，简洁）。
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export type VisionLang = 'zh' | 'en';
export type VisionFormat = 'text' | 'json';

const KEEP_SOURCE_KEYS = new Set(['extract_text', 'code_from_screenshot']);
const JSON_FORMAT_KEYS = new Set(['diagnose_error', 'describe_ui']);

export function applyFormat(
  prompt: string,
  format: VisionFormat | undefined,
  promptKey: string
): string {
  if (format !== 'json') return prompt;
  if (promptKey === 'diagnose_error') {
    return `${prompt}\n\nReturn JSON only, no markdown fences. Use exactly these property names: error_message (string), causes (array of strings), fixes (array of strings), prevention (string).`;
  }
  if (promptKey === 'describe_ui') {
    return `${prompt}\n\nReturn JSON only, no markdown fences. Use exactly these property names: layout (string), components (array of strings), labels (array of strings), state (string).`;
  }
  return prompt;
}

function makeFormatError(message: string): Error {
  const err = new Error(message);
  err.name = 'FormatError';
  return err;
}

function extractJsonFromFences(text: string): string {
  const trimmed = text.trim();
  const fenceRe = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/;
  const m = trimmed.match(fenceRe);
  return m ? m[1].trim() : trimmed;
}

function validateDiagnoseError(obj: Record<string, unknown>): void {
  if (typeof obj.error_message !== 'string') {
    throw makeFormatError('Missing or invalid field "error_message"（卡在 JSON 格式化）');
  }
  if (!Array.isArray(obj.causes)) {
    throw makeFormatError('Missing or invalid field "causes"（卡在 JSON 格式化）');
  }
  for (const item of obj.causes) {
    if (typeof item !== 'string') {
      throw makeFormatError('Invalid item in "causes"（卡在 JSON 格式化）');
    }
  }
  if (!Array.isArray(obj.fixes)) {
    throw makeFormatError('Missing or invalid field "fixes"（卡在 JSON 格式化）');
  }
  for (const item of obj.fixes) {
    if (typeof item !== 'string') {
      throw makeFormatError('Invalid item in "fixes"（卡在 JSON 格式化）');
    }
  }
  if (typeof obj.prevention !== 'string') {
    throw makeFormatError('Missing or invalid field "prevention"（卡在 JSON 格式化）');
  }
}

function validateDescribeUi(obj: Record<string, unknown>): void {
  if (typeof obj.layout !== 'string') {
    throw makeFormatError('Missing or invalid field "layout"（卡在 JSON 格式化）');
  }
  if (!Array.isArray(obj.components)) {
    throw makeFormatError('Missing or invalid field "components"（卡在 JSON 格式化）');
  }
  for (const item of obj.components) {
    if (typeof item !== 'string') {
      throw makeFormatError('Invalid item in "components"（卡在 JSON 格式化）');
    }
  }
  if (!Array.isArray(obj.labels)) {
    throw makeFormatError('Missing or invalid field "labels"（卡在 JSON 格式化）');
  }
  for (const item of obj.labels) {
    if (typeof item !== 'string') {
      throw makeFormatError('Invalid item in "labels"（卡在 JSON 格式化）');
    }
  }
  if (typeof obj.state !== 'string') {
    throw makeFormatError('Missing or invalid field "state"（卡在 JSON 格式化）');
  }
}

export function parseToolJson(
  text: string,
  promptKey: 'diagnose_error' | 'describe_ui'
): string {
  const jsonText = extractJsonFromFences(text);
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(jsonText) as Record<string, unknown>;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw makeFormatError(`Failed to parse JSON response（卡在 JSON 格式化）: ${detail}`);
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw makeFormatError('JSON root must be an object（卡在 JSON 格式化）');
  }
  if (promptKey === 'diagnose_error') {
    validateDiagnoseError(obj);
  } else {
    validateDescribeUi(obj);
  }
  return JSON.stringify(obj, null, 2);
}

/** promptKey 用于区分是否保留图内原文/代码 */
export function applyLang(
  prompt: string,
  lang: VisionLang | undefined,
  promptKey: string,
  format?: VisionFormat
): string {
  if (lang === undefined) return prompt;
  if (format === 'json') {
    const suffix =
      lang === 'zh'
        ? 'Use Simplified Chinese for all JSON string values. Keep property names exactly as specified. Return JSON only.'
        : 'Use English for all JSON string values. Keep property names exactly as specified. Return JSON only.';
    return `${prompt}\n\n${suffix}`;
  }
  if (KEEP_SOURCE_KEYS.has(promptKey)) {
    const suffix =
      lang === 'zh'
        ? 'Keep extracted text/code in the original language from the image; write any labels/headings/meta in Simplified Chinese.'
        : 'Keep extracted text/code in the original language from the image; write any labels/headings/meta in English.';
    return `${prompt}\n\n${suffix}`;
  }
  const suffix =
    lang === 'zh'
      ? 'Respond entirely in Simplified Chinese.'
      : 'Respond entirely in English.';
  return `${prompt}\n\n${suffix}`;
}

export const PROMPTS: Record<string, string> = {
  analyze:
    'Describe this image in detail. Include all relevant elements, context, and anything useful for someone who cannot see the image.',
  extract_text:
    'Extract all text from this image. Return only the text, preserving layout and line breaks. No commentary.',
  describe_ui:
    'Analyze this UI screenshot. Describe: 1) overall layout 2) components (buttons, forms, navigation, inputs) 3) visible text and labels 4) state (error toasts, active tabs, modals, etc.).',
  diagnose_error:
    'Analyze this error screenshot. Return: 1) the exact error message 2) likely causes 3) concrete fix steps 4) how to avoid it in the future.',
  understand_diagram:
    'Interpret this diagram. Return: 1) diagram type 2) components and their roles 3) relationships/flow 4) overall purpose.',
  analyze_chart:
    'Analyze this data chart. Return: 1) chart type 2) axes and labels 3) key trends 4) notable data points 5) insights.',
  code_from_screenshot:
    'Extract all code from this screenshot. Return: 1) programming language 2) formatted code block, preserving indentation.',
  compare:
    'Compare image A (first) and image B (second). Return: 1) what changed 2) what stayed the same 3) likely intent or impact of the differences. Be specific about UI text, layout, colors, and errors when visible.',
};

const sourceProps = {
  source: {
    type: 'string' as const,
    enum: ['clipboard', 'path', 'screenshot', 'base64'],
    description:
      'Image source: clipboard, file path, full-screen screenshot, or inline base64.',
  },
  image_path: {
    type: 'string' as const,
    description: 'Absolute path to the image file (required when source=path).',
  },
  image_base64: {
    type: 'string' as const,
    description:
      'Raw base64 or data URL (data:image/<subtype>;base64,<payload>); required when source=base64.',
  },
  lang: {
    type: 'string' as const,
    enum: ['zh', 'en'],
    description:
      'Optional response language: zh (Simplified Chinese) or en. Omit to keep default prompts. For OCR/code tools, image text/code stay untranslated.',
  },
  region: {
    type: 'object' as const,
    description:
      'Optional crop region applied after rasterization (HEIC transcode) and before downscale. Use to focus on a toast, code block, or UI corner.',
    properties: {
      x: { type: 'number', description: 'Left edge of the crop rectangle.' },
      y: { type: 'number', description: 'Top edge of the crop rectangle.' },
      width: { type: 'number', description: 'Crop width (> 0).' },
      height: { type: 'number', description: 'Crop height (> 0).' },
      unit: {
        type: 'string',
        enum: ['px', 'ratio'],
        description:
          'Coordinate unit: px = pixels on the current raster image; ratio = normalized [0,1] fractions (width is fraction of image width).',
      },
    },
    required: ['x', 'y', 'width', 'height', 'unit'],
  },
};

const formatProp = {
  type: 'string' as const,
  enum: ['text', 'json'],
  description:
    'Optional response format: text (prose, default) or json (structured fields). Only supported on describe_ui and diagnose_error.',
};

const regionSchema = {
  type: 'object' as const,
  description:
    'Optional crop region applied after rasterization (HEIC transcode) and before downscale. Use to focus on a toast, code block, or UI corner.',
  properties: {
    x: { type: 'number', description: 'Left edge of the crop rectangle.' },
    y: { type: 'number', description: 'Top edge of the crop rectangle.' },
    width: { type: 'number', description: 'Crop width (> 0).' },
    height: { type: 'number', description: 'Crop height (> 0).' },
    unit: {
      type: 'string',
      enum: ['px', 'ratio'],
      description:
        'Coordinate unit: px = pixels on the current raster image; ratio = normalized [0,1] fractions (width is fraction of image width).',
    },
  },
  required: ['x', 'y', 'width', 'height', 'unit'],
};

function compareImagesTool(): Tool {
  return {
    name: 'compare_images',
    description:
      'Compare two images side by side (A=first, B=second): before/after UI, bug fixes, layout changes. Each side uses its own source (clipboard|path|screenshot|base64). For true before/after, prefer path or base64 — consecutive clipboard reads may return the same image.',
    inputSchema: {
      type: 'object',
      properties: {
        source_a: {
          type: 'string',
          enum: ['clipboard', 'path', 'screenshot', 'base64'],
          description: 'Image A (first) source.',
        },
        source_b: {
          type: 'string',
          enum: ['clipboard', 'path', 'screenshot', 'base64'],
          description: 'Image B (second) source.',
        },
        image_path_a: {
          type: 'string',
          description: 'Absolute path to image A (required when source_a=path).',
        },
        image_path_b: {
          type: 'string',
          description: 'Absolute path to image B (required when source_b=path).',
        },
        image_base64_a: {
          type: 'string',
          description:
            'Raw base64 or data URL for image A; required when source_a=base64.',
        },
        image_base64_b: {
          type: 'string',
          description:
            'Raw base64 or data URL for image B; required when source_b=base64.',
        },
        prompt: {
          type: 'string',
          description: 'Custom comparison focus (overrides the default prompt).',
        },
        lang: {
          type: 'string',
          enum: ['zh', 'en'],
          description:
            'Optional response language: zh (Simplified Chinese) or en. Omit to keep default prompts.',
        },
        region_a: {
          ...regionSchema,
          description:
            'Optional crop region for image A (same structure as single-image region).',
        },
        region_b: {
          ...regionSchema,
          description:
            'Optional crop region for image B (same structure as single-image region).',
        },
      },
      required: ['source_a', 'source_b'],
    },
  };
}

function capabilityTool(
  name: string,
  en: string,
  opts?: { withPrompt?: boolean; withFormat?: boolean }
): Tool {
  const properties: { [x: string]: object } = { ...sourceProps };
  if (opts?.withPrompt) {
    properties.prompt = {
      type: 'string',
      description: 'Custom question (overrides the default prompt).',
    };
  }
  if (opts?.withFormat) {
    properties.format = formatProp;
  }
  return {
    name,
    description: en,
    inputSchema: {
      type: 'object',
      properties,
      required: ['source'],
    },
  };
}

export function buildTools(): Tool[] {
  return [
    capabilityTool(
      'analyze_image',
      'Describe an image (generic analysis). Optional `prompt` for a custom question. Set source=clipboard, source=path, source=screenshot, or source=base64.',
      { withPrompt: true }
    ),
    capabilityTool(
      'extract_text',
      'OCR an image and return all text. Set source=clipboard, source=path, source=screenshot, or source=base64.'
    ),
    capabilityTool(
      'describe_ui',
      'Analyze a UI screenshot: layout, components, text, state. Set source=clipboard, source=path, source=screenshot, or source=base64. Optional format=json for structured output.',
      { withFormat: true }
    ),
    capabilityTool(
      'diagnose_error',
      'Diagnose an error screenshot: exact error, causes, fix steps. Set source=clipboard, source=path, source=screenshot, or source=base64. Optional format=json for structured output.',
      { withFormat: true }
    ),
    capabilityTool(
      'understand_diagram',
      'Interpret a diagram (flowchart, architecture, sequence). Set source=clipboard, source=path, source=screenshot, or source=base64.'
    ),
    capabilityTool(
      'analyze_chart',
      'Analyze a data chart (line/bar/pie): type, axes, trends, insights. Set source=clipboard, source=path, source=screenshot, or source=base64.'
    ),
    capabilityTool(
      'code_from_screenshot',
      'Extract editable code from a screenshot. Set source=clipboard, source=path, source=screenshot, or source=base64.'
    ),
    compareImagesTool(),
  ];
}
