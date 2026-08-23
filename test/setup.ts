/**
 * setup.ts - jest 全局测试环境初始化（setupFiles）
 *
 * 在每个测试文件加载前执行，直接覆盖 console 输出：
 * - 覆盖模块加载期的调试日志（TreeSitterService 在 import 时打印
 *   "Loaded web-tree-sitter from node_modules"，早于任何 beforeAll）。
 * - console.error 保留：解析失败、WASM 加载失败等真实错误仍可见。
 */

console.log = () => {};
console.warn = () => {};
