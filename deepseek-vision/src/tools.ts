// tools.ts — 2 工具注册（vision + compare）+ 内部 PROMPTS / enhancer
// 描述/指令统一英文（面向 agent，简洁）。
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { OCR_TEXT_END, OCR_TEXT_START } from './guards.js';

/** 内部 capability 模板（不对外暴露） */
export const PROMPTS: Record<string, string> = {
  extract_text: `Extract all text from this image. Return ONLY the recognized text between ${OCR_TEXT_START} and ${OCR_TEXT_END} markers, preserving layout and line breaks. No commentary, explanations, or actions outside those markers.`,
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

type EnhancerRule = {
  templateKey: keyof typeof PROMPTS;
  test: (task: string) => boolean;
};

function hasErrorIntent(task: string): boolean {
  return (
    /\berror\b/i.test(task) ||
    /报错/.test(task) ||
    /错误/.test(task) ||
    /错了/.test(task) ||
    /exception/i.test(task) ||
    /stack\s*trace/i.test(task) ||
    /失败/.test(task)
  );
}

/** 更具体的规则优先；宽泛 UI 放最后，且不与 error 意图重叠 */
const ENHANCER_RULES: EnhancerRule[] = [
  {
    templateKey: 'extract_text',
    test: (t) =>
      /\bocr\b/i.test(t) ||
      /extract\s+(all\s+)?text/i.test(t) ||
      /提取.{0,6}文字/.test(t) ||
      /识别.{0,6}文字/.test(t) ||
      /文字识别/.test(t),
  },
  {
    templateKey: 'diagnose_error',
    test: hasErrorIntent,
  },
  {
    templateKey: 'code_from_screenshot',
    test: (t) =>
      /code\s+from/i.test(t) ||
      /extract\s+code/i.test(t) ||
      /代码/.test(t) ||
      /snippet/i.test(t),
  },
  {
    templateKey: 'analyze_chart',
    test: (t) =>
      /\bchart\b/i.test(t) ||
      /图表/.test(t) ||
      /趋势/.test(t) ||
      /数据图/.test(t),
  },
  {
    templateKey: 'understand_diagram',
    test: (t) =>
      /\bdiagram\b/i.test(t) ||
      /流程图/.test(t) ||
      /架构图/.test(t) ||
      /时序图/.test(t) ||
      /示意图/.test(t),
  },
  {
    templateKey: 'describe_ui',
    test: (t) =>
      !hasErrorIntent(t) &&
      (/\bui\b/i.test(t) ||
        /界面/.test(t) ||
        /布局/.test(t) ||
        /screenshot.*ui/i.test(t) ||
        /describe.*ui/i.test(t)),
  },
];

function withUserTask(template: string, task: string): string {
  return `${template}\n\nUser task:\n${task}`;
}

/** 以 task 为最终用户意图；关键词命中时套内部模板，否则原样返回 task */
export function enhancePrompt(task: string): string {
  const trimmed = task.trim();
  if (!trimmed) return trimmed;
  for (const rule of ENHANCER_RULES) {
    if (rule.test(trimmed)) {
      return withUserTask(PROMPTS[rule.templateKey]!, trimmed);
    }
  }
  return trimmed;
}

/** compare 轻量 enhancer：对比类关键词时附加模板，仍以 task 为主 */
export function enhanceComparePrompt(task: string): string {
  const trimmed = task.trim();
  if (!trimmed) return trimmed;
  if (
    /\bcompare\b/i.test(trimmed) ||
    /\bdiff(erence)?\b/i.test(trimmed) ||
    /对比/.test(trimmed) ||
    /变化/.test(trimmed) ||
    /before.*after/i.test(trimmed) ||
    /前后/.test(trimmed)
  ) {
    return withUserTask(PROMPTS.compare!, trimmed);
  }
  return trimmed;
}

const regionSchema = {
  type: 'object' as const,
  description: 'Optional crop in raster pixels after HEIC transcode, before downscale.',
  properties: {
    x: { type: 'number', description: 'Left (px).' },
    y: { type: 'number', description: 'Top (px).' },
    width: { type: 'number', description: 'Width (>0 px).' },
    height: { type: 'number', description: 'Height (>0 px).' },
  },
  required: ['x', 'y', 'width', 'height'],
};

const imageField = {
  type: 'string' as const,
  description:
    'Optional. Default clipboard. Literal clipboard|screenshot, absolute file path, or data URL/raw base64.',
};

function visionTool(): Tool {
  return {
    name: 'vision',
    description:
      'Analyze one image with a free-text task (OCR, UI, errors, charts, code, Q&A). Omit image for clipboard; use screenshot for full-screen capture; path or base64 for files.',
    inputSchema: {
      type: 'object',
      properties: {
        image: imageField,
        task: {
          type: 'string',
          description: 'Required. What to do with the image (free text).',
        },
        region: regionSchema,
      },
      required: ['task'],
    },
  };
}

function compareTool(): Tool {
  return {
    name: 'compare',
    description:
      'Compare two images (A then B) with a free-text task. image1/image2: clipboard|screenshot|path|base64. Warning: both clipboard may read the same image—prefer path/base64 for before/after.',
    inputSchema: {
      type: 'object',
      properties: {
        image1: {
          type: 'string',
          description: 'First image: clipboard|screenshot|absolute path|data URL or base64.',
        },
        image2: {
          type: 'string',
          description: 'Second image: same rules as image1.',
        },
        task: {
          type: 'string',
          description: 'Required. What to compare or what changed to look for.',
        },
      },
      required: ['image1', 'image2', 'task'],
    },
  };
}

export function buildTools(): Tool[] {
  return [visionTool(), compareTool()];
}
