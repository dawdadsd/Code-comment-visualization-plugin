/**
 * sync-vendors.js - 同步前端第三方资源（KaTeX / Mermaid / highlight.js）到 media/vendor/
 *
 * **背景：**
 * Webview 原本通过 cdn.jsdelivr.net 加载 KaTeX / Mermaid / highlight.js，
 * 离线或内网环境下不可用。这些资源改为随 VSIX 分发，保证插件完全离线工作。
 *
 * 各资源来源（均为 devDependencies，可从 npm 获取，不进入 git 仓库）：
 * - katex        -> dist/katex.min.css、dist/katex.min.js、dist/contrib/auto-render.min.js、dist/fonts/
 * - mermaid      -> dist/mermaid.min.js
 * - @highlightjs/cdn-assets -> highlight.min.js、styles/vs2015.min.css
 *
 * 运行：node scripts/sync-vendors.js
 *
 * @author xiaowu
 * @since 2026/08/06
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const vendorDir = path.join(root, "media", "vendor");

// 通过 require.resolve 定位包真实路径（兼容 pnpm 符号链接结构）
const katexPkg = path.dirname(require.resolve("katex/package.json"));
const mermaidPkg = path.dirname(require.resolve("mermaid/package.json"));
const hljsPkg = path.dirname(
  require.resolve("@highlightjs/cdn-assets/package.json"),
);

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

console.log("[sync-vendors] KaTeX");
const katexDist = path.join(katexPkg, "dist");
copy(
  path.join(katexDist, "katex.min.css"),
  path.join(vendorDir, "katex.min.css"),
);
copy(path.join(katexDist, "katex.min.js"), path.join(vendorDir, "katex.min.js"));
copy(
  path.join(katexDist, "contrib", "auto-render.min.js"),
  path.join(vendorDir, "auto-render.min.js"),
);
let fontCount = 0;
for (const name of fs.readdirSync(path.join(katexDist, "fonts"))) {
  if (name.endsWith(".woff2")) {
    copy(
      path.join(katexDist, "fonts", name),
      path.join(vendorDir, "fonts", name),
    );
    fontCount += 1;
  }
}

console.log("[sync-vendors] Mermaid");
copy(
  path.join(mermaidPkg, "dist", "mermaid.min.js"),
  path.join(vendorDir, "mermaid.min.js"),
);

console.log("[sync-vendors] highlight.js");
copy(
  path.join(hljsPkg, "highlight.min.js"),
  path.join(vendorDir, "highlight.min.js"),
);
// 深色主题（vs2015）+ 浅色主题（github），运行时按编辑器主题切换
copy(
  path.join(hljsPkg, "styles", "vs2015.min.css"),
  path.join(vendorDir, "vs2015.min.css"),
);
copy(
  path.join(hljsPkg, "styles", "github.min.css"),
  path.join(vendorDir, "github.min.css"),
);

console.log("[sync-vendors] catppuccin 四风味主题");
const catppPkg = path.dirname(
  require.resolve("@catppuccin/highlightjs/package.json"),
);
// 四个风味：latte（浅色）/ frappe / macchiato / mocha（三种深色）
for (const flavor of ["latte", "frappe", "macchiato", "mocha"]) {
  copy(
    path.join(catppPkg, "css", `catppuccin-${flavor}.css`),
    path.join(vendorDir, `catppuccin-${flavor}.css`),
  );
}

console.log(
  `[sync-vendors] 完成：KaTeX(${fontCount} 字体) + Mermaid + highlight.js`,
);
