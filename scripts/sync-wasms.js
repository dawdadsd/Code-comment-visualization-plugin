/**
 * sync-wasms.js - 从 node_modules 同步 tree-sitter 引擎与语言 grammar 到 media/
 *
 * **背景：**
 * - media/lib/web-tree-sitter.cjs  <-  web-tree-sitter 包的 tree-sitter.js（引擎）
 * - media/lib/*.wasm               <-  web-tree-sitter 包的 tree-sitter.wasm（引擎 wasm）
 * - media/wasms/*.wasm             <-  tree-sitter-wasms 包的 out/*.wasm（各语言 grammar）
 *
 * 以上二进制均来自 npm dependencies，不进入 git 仓库；
 * 打包 VSIX 前执行本脚本（vscode:prepublish 已接入），保证产物齐全。
 *
 * 运行：node scripts/sync-wasms.js
 *
 * @author xiaowu
 * @since 2026/08/06
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");

// 通过 require.resolve 定位包真实路径（兼容 pnpm 符号链接结构）
const enginePkg = path.dirname(require.resolve("web-tree-sitter/package.json"));
const wasmsPkg = path.dirname(require.resolve("tree-sitter-wasms/package.json"));

const libDir = path.join(root, "media", "lib");
const wasmsDir = path.join(root, "media", "wasms");

/**
 * 复制单个文件到目标位置（自动创建父目录）
 *
 * @param src  - 源文件路径
 * @param dest - 目标文件路径
 */
function copy(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log("  ✓ " + path.relative(root, dest));
}

console.log("[sync-wasms] 引擎 (web-tree-sitter)");
copy(
  path.join(enginePkg, "tree-sitter.js"),
  path.join(libDir, "web-tree-sitter.cjs"),
);
copy(
  path.join(enginePkg, "tree-sitter.wasm"),
  path.join(libDir, "web-tree-sitter.wasm"),
);
copy(
  path.join(enginePkg, "tree-sitter.wasm"),
  path.join(libDir, "tree-sitter.wasm"),
);

console.log("[sync-wasms] 语言 grammar (tree-sitter-wasms)");
const outDir = path.join(wasmsPkg, "out");
let count = 0;
for (const name of fs.readdirSync(outDir)) {
  if (name.endsWith(".wasm")) {
    copy(path.join(outDir, name), path.join(wasmsDir, name));
    count += 1;
  }
}
console.log(`[sync-wasms] 完成：引擎 3 个 + 语言 grammar ${count} 个`);
