// tools.ts — 2 工具注册（deepseek_vision + compare_images）+ PROMPTS（capability key）
// 描述/指令统一英文（面向 agent，简洁）。
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export type VisionLang = 'zh' | 'en';
export type VisionFormat = 'text' | 'json';

export const VISION_CAPABILITIES = [
  'analyze',
  'extract_text',
  'describe_ui',
  'diagnose_error',
  'understand_diagram',
  'analyze_chart',
  'code_from_screenshot',
] as const;

export type VisionCapability = (typeof VISION_CAPABILITIES)[number];

const KEEP_SOURCE_KEYS = new Set(['extract_text', 'code_from_screenshot']);

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
    description: 'clipboard | path | screenshot | base64.',
  },
  image_path: {
    type: 'string' as const,
    description: 'Required when source=path.',
  },
  image_base64: {
    type: 'string' as const,
    description: 'Raw base64 or data URL; required when source=base64.',
  },
  lang: {
    type: 'string' as const,
    enum: ['zh', 'en'],
    description: 'Optional zh|en. OCR/code: image text untranslated.',
  },
  region: {
    type: 'object' as const,
    description: 'Optional crop after HEIC transcode, before downscale.',
    properties: {
      x: { type: 'number', description: 'Left.' },
      y: { type: 'number', description: 'Top.' },
      width: { type: 'number', description: 'Width (>0).' },
      height: { type: 'number', description: 'Height (>0).' },
      unit: {
        type: 'string',
        enum: ['px', 'ratio'],
        description: 'px | ratio.',
      },
    },
    required: ['x', 'y', 'width', 'height', 'unit'],
  },
};

const formatProp = {
  type: 'string' as const,
  enum: ['text', 'json'],
  description: 'text|json. Only when capability is describe_ui or diagnose_error.',
};

const regionSchema = {
  type: 'object' as const,
  description: 'Optional crop after HEIC transcode, before downscale.',
  properties: {
    x: { type: 'number', description: 'Left.' },
    y: { type: 'number', description: 'Top.' },
    width: { type: 'number', description: 'Width (>0).' },
    height: { type: 'number', description: 'Height (>0).' },
    unit: {
      type: 'string',
      enum: ['px', 'ratio'],
      description: 'px | ratio.',
    },
  },
  required: ['x', 'y', 'width', 'height', 'unit'],
};

function deepseekVisionTool(): Tool {
  return {
    name: 'deepseek_vision',
    description:
      'Single-image vision. Args: capability, source; image_path if path; image_base64 if base64. Optional: lang, region; prompt if capability=analyze; format if describe_ui|diagnose_error.',
    inputSchema: {
      type: 'object',
      properties: {
        capability: {
          type: 'string',
          enum: [...VISION_CAPABILITIES],
          description: 'Vision task.',
        },
        ...sourceProps,
        prompt: {
          type: 'string',
          description: 'Custom question; only when capability=analyze.',
        },
        format: formatProp,
      },
      required: ['capability', 'source'],
    },
  };
}

function compareImagesTool(): Tool {
  return {
    name: 'compare_images',
    description:
      'Compare image A then B. source_a/source_b (+ path/base64 fields). Optional: prompt, lang, region_a/region_b. Prefer path|base64 for distinct before/after (clipboard may repeat).',
    inputSchema: {
      type: 'object',
      properties: {
        source_a: {
          type: 'string',
          enum: ['clipboard', 'path', 'screenshot', 'base64'],
          description: 'Image A source.',
        },
        source_b: {
          type: 'string',
          enum: ['clipboard', 'path', 'screenshot', 'base64'],
          description: 'Image B source.',
        },
        image_path_a: {
          type: 'string',
          description: 'Required when source_a=path.',
        },
        image_path_b: {
          type: 'string',
          description: 'Required when source_b=path.',
        },
        image_base64_a: {
          type: 'string',
          description: 'Required when source_a=base64.',
        },
        image_base64_b: {
          type: 'string',
          description: 'Required when source_b=base64.',
        },
        prompt: {
          type: 'string',
          description: 'Optional; overrides default compare prompt.',
        },
        lang: {
          type: 'string',
          enum: ['zh', 'en'],
          description: 'Optional zh|en.',
        },
        region_a: {
          ...regionSchema,
          description: 'Optional crop for image A.',
        },
        region_b: {
          ...regionSchema,
          description: 'Optional crop for image B.',
        },
      },
      required: ['source_a', 'source_b'],
    },
  };
}

export function buildTools(): Tool[] {
  return [deepseekVisionTool(), compareImagesTool()];
}
