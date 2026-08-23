/**
 * jest.config.js - jest 单元测试配置
 *
 * 测试分层（精准定位问题）：
 * - 纯单元测试（快）：fieldType / tagParser，跑 `pnpm test:unit`
 * - 解析器集成测试（慢，加载 WASM）：parser / parserEdge，跑 `pnpm test:parser`
 * - 全量：`pnpm test`
 */
/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/test"],
  testMatch: ["**/*.test.ts"],

  // ---- 诊断与输出 ----
  verbose: true, // 逐个列出用例结果，快速定位失败项
  slowTestThreshold: 30000, // 超过 30s 的用例告警（WASM 首次加载可能较慢）
  testTimeout: 120000, // 统一超时：WASM grammar 首次加载较慢
  detectOpenHandles: true, // 测试结束后检查未关闭句柄（定位资源泄漏）

  // ---- 环境与隔离 ----
  setupFiles: ["<rootDir>/test/setup.ts"], // 测试文件加载前执行，静音模块加载期日志
  clearMocks: true, // 每个用例前自动清理 spy.mock.calls / results

  // ---- 模块映射 ----
  moduleNameMapper: {
    // vscode 模块映射到测试 mock（解析链路依赖 vscode API）
    "^vscode$": "<rootDir>/test/mocks/vscode.ts",
    // NodeNext 源码使用 "./xxx.js" 相对导入，映射回 .ts 源文件
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/test/tsconfig.json" }],
  },
};
