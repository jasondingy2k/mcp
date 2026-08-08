// tools.ts — 7 个工具注册 + 7 个 PROMPTS（能力=工具名，来源=source 参数）
// 描述/指令统一英文（面向 agent，简洁）。
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

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
};

const sourceProps = {
  source: {
    type: 'string' as const,
    enum: ['clipboard', 'path'],
    description: 'Image source: clipboard or file path.',
  },
  image_path: {
    type: 'string' as const,
    description: 'Absolute path to the image file (required when source=path).',
  },
};

function capabilityTool(name: string, en: string, withPrompt = false): Tool {
  const properties: { [x: string]: object } = { ...sourceProps };
  if (withPrompt) {
    properties.prompt = {
      type: 'string',
      description: 'Custom question (overrides the default prompt).',
    };
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
      'Describe an image (generic analysis). Optional `prompt` for a custom question. Set source=clipboard or source=path.',
      true
    ),
    capabilityTool(
      'extract_text',
      'OCR an image and return all text. Set source=clipboard or source=path.'
    ),
    capabilityTool(
      'describe_ui',
      'Analyze a UI screenshot: layout, components, text, state. Set source=clipboard or source=path.'
    ),
    capabilityTool(
      'diagnose_error',
      'Diagnose an error screenshot: exact error, causes, fix steps. Set source=clipboard or source=path.'
    ),
    capabilityTool(
      'understand_diagram',
      'Interpret a diagram (flowchart, architecture, sequence). Set source=clipboard or source=path.'
    ),
    capabilityTool(
      'analyze_chart',
      'Analyze a data chart (line/bar/pie): type, axes, trends, insights. Set source=clipboard or source=path.'
    ),
    capabilityTool(
      'code_from_screenshot',
      'Extract editable code from a screenshot. Set source=clipboard or source=path.'
    ),
  ];
}
