#!/usr/bin/env node
// index.ts — deepseek-vision 入口（stdio）
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { pathToFileURL } from 'url';
import { resolve } from 'path';
import { apiKey, baseUrl, modelName } from './config.js';
import { VisionClient, createServer } from './server.js';

const key = apiKey();
const visionClient = key ? new VisionClient(key, baseUrl(), modelName()) : null;
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
