#!/usr/bin/env node
// index.ts — deepseek-vision 入口（stdio）
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { pathToFileURL } from 'url';
import { resolve } from 'path';
import { loadVisionProviders, validateVisionConfig } from './config.js';
import { VisionClient, createServer } from './server.js';

const configErrors = validateVisionConfig();
if (configErrors.length > 0) {
  console.error(`[deepseek-vision] Config error: ${configErrors.join('; ')}`);
  process.exit(1);
}

const providers = loadVisionProviders();
const visionClient = providers.length > 0 ? new VisionClient(providers) : null;
const server = createServer(visionClient);

// 直接运行守卫：测试 import 本模块时不会启动服务器。
const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  } catch (e) {
    const msg = (e as Error)?.message ?? e;
    // 致命启动错误：即使静默日志模式也打到 stderr，便于宿主诊断
    console.error(`[deepseek-vision] Fatal: ${msg}`);
    process.exit(1);
  }
}
