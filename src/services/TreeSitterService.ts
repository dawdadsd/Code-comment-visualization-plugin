/**
 * TreeSitterService.ts - 基于 web-tree-sitter 的语法分析服务
 *
 * 【职责】
 * 1. 管理 web-tree-sitter 解析器引擎的生命周期
 * 2. 按需加载各语言的 WASM grammar 文件
 * 3. 提供从 AST 提取字段类型 / 方法签名的能力
 *
 * 【设计原则】
 * - 懒加载：首次调用时才初始化引擎和加载 grammar
 * - 缓存：已加载的 language 会被缓存
 * - 健壮性：任何异常返回 null，调用方回退到文本解析
 */

import type { Parser, Language, Tree, Node } from "web-tree-sitter";
import * as path from "path";
import * as fs from "fs";

// ========== 动态模块加载 ==========

/**
 * 动态加载 web-tree-sitter 模块
 * 优先从 node_modules 加载（开发环境），回退到 media/lib（VSIX 环境）
 */
function loadWebTreeSitter(): typeof import("web-tree-sitter") | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("web-tree-sitter");
    console.log("[TreeSitterService] Loaded web-tree-sitter from node_modules");
    return mod;
  } catch (e1) {
    const msg1 = e1 instanceof Error ? e1.message : String(e1);
    console.warn("[TreeSitterService] node_modules load failed:", msg1);
    try {
      const libPath = path.join(
        __dirname,
        "..",
        "..",
        "media",
        "lib",
        "web-tree-sitter.cjs",
      );
      console.log("[TreeSitterService] Trying fallback path:", libPath);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(libPath);
      console.log("[TreeSitterService] Loaded web-tree-sitter from media/lib");
      return mod;
    } catch (e2) {
      const msg2 = e2 instanceof Error ? e2.message : String(e2);
      console.error("[TreeSitterService] Fallback load also failed:", msg2);
      return null;
    }
  }
}

const webTreeSitterModule = loadWebTreeSitter();

// ========== 语言 ID → WASM 文件名映射 ==========

const LANGUAGE_WASM_MAP: Readonly<Record<string, string>> = {
  c: "tree-sitter-c.wasm",
  cpp: "tree-sitter-cpp.wasm",
  csharp: "tree-sitter-c_sharp.wasm",
  java: "tree-sitter-java.wasm",
  javascript: "tree-sitter-javascript.wasm",
  javascriptreact: "tree-sitter-javascript.wasm",
  typescript: "tree-sitter-typescript.wasm",
  typescriptreact: "tree-sitter-tsx.wasm",
  python: "tree-sitter-python.wasm",
  ruby: "tree-sitter-ruby.wasm",
  go: "tree-sitter-go.wasm",
  rust: "tree-sitter-rust.wasm",
  php: "tree-sitter-php.wasm",
  lua: "tree-sitter-lua.wasm",
  dart: "tree-sitter-dart.wasm",
  swift: "tree-sitter-swift.wasm",
  kotlin: "tree-sitter-kotlin.wasm",
  scala: "tree-sitter-scala.wasm",
  "objective-c": "tree-sitter-objc.wasm",
  vue: "tree-sitter-vue.wasm",
};

// ========== AST 节点类型集合 ==========

/** 字段声明节点类型（跨语言） */
const FIELD_DECLARATION_TYPES = new Set([
  "field_declaration", // C++, Java, Rust
  "field_definition", // 部分语法
  "public_field_definition", // TypeScript
  "variable_declarator", // JavaScript (const x = ...)
  "var_spec", // Go
  "annotated_assignment", // Python (x: int = ...)
]);

/** 函数/方法声明节点类型（跨语言） */
const METHOD_DECLARATION_TYPES = new Set([
  "function_definition", // C++, Python
  "function_declaration", // C, Go, JavaScript
  "method_declaration", // Java
  "method_definition", // TypeScript, JavaScript
  "function_item", // Rust
  "constructor_declaration", // Java
  "constructor_definition", // C++
  "constructor", // 部分语法
  "arrow_function", // TypeScript/JavaScript
]);

// ========== 服务实现 ==========

export class TreeSitterService {
  private static instance: TreeSitterService | null = null;
  private parser: Parser | null = null;
  private readonly languages: Map<string, Language> = new Map();
  private initPromise: Promise<void> | null = null;
  private readonly wasmsDir: string;

  private constructor() {
    // 编译后的 JS 在 out/services/ 下，WASM 文件在 media/wasms/ 下
    this.wasmsDir = path.join(__dirname, "..", "..", "media", "wasms");
  }

  /** 获取单例实例 */
  static getInstance(): TreeSitterService {
    if (!TreeSitterService.instance) {
      TreeSitterService.instance = new TreeSitterService();
    }
    return TreeSitterService.instance;
  }

  /** 确保引擎已初始化 */
  private async ensureInitialized(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInit();
    }
    await this.initPromise;
  }

  private async doInit(): Promise<void> {
    if (!webTreeSitterModule) {
      throw new Error("web-tree-sitter module not loaded");
    }
    try {
      // 定位 web-tree-sitter.wasm 引擎文件
      const engineWasm = this.locateEngineWasm();
      const initOptions = engineWasm
        ? {
            locateFile: (filename: string) =>
              filename.endsWith(".wasm") ? engineWasm : filename,
          }
        : undefined;
      console.log("[TreeSitterService] Initializing parser, engineWasm:", engineWasm);
      await webTreeSitterModule.Parser.init(initOptions);
      this.parser = new webTreeSitterModule.Parser();
      console.log("[TreeSitterService] Parser initialized successfully");
    } catch (error) {
      console.error("[TreeSitterService] Failed to initialize:", error);
      throw error;
    }
  }

  /**
   * 定位 web-tree-sitter.wasm 引擎文件
   * 开发环境：node_modules/web-tree-sitter/web-tree-sitter.wasm
   * VSIX 环境：media/lib/web-tree-sitter.wasm
   */
  private locateEngineWasm(): string | null {
    const candidates = [
      path.join(__dirname, "..", "..", "node_modules", "web-tree-sitter", "web-tree-sitter.wasm"),
      path.join(__dirname, "..", "..", "media", "lib", "web-tree-sitter.wasm"),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  /** 加载语言 grammar（带缓存） */
  private async getLanguage(languageId: string): Promise<Language | null> {
    const wasmFile = LANGUAGE_WASM_MAP[languageId];
    if (!wasmFile) return null;

    if (this.languages.has(languageId)) {
      return this.languages.get(languageId) ?? null;
    }

    try {
      const wasmPath = path.join(this.wasmsDir, wasmFile);
      console.log(`[TreeSitterService] Loading grammar: ${wasmPath}`);
      const language = await webTreeSitterModule!.Language.load(wasmPath);
      this.languages.set(languageId, language);
      console.log(`[TreeSitterService] Grammar loaded: ${languageId}`);
      return language;
    } catch (error) {
      console.error(
        `[TreeSitterService] Failed to load language ${languageId}:`,
        error,
      );
      return null;
    }
  }

  /** 判断语言是否支持（模块已加载且 grammar 文件存在） */
  static isLanguageSupported(languageId: string): boolean {
    return webTreeSitterModule !== null && languageId in LANGUAGE_WASM_MAP;
  }

  /** 解析源代码，返回 AST */
  async parse(
    sourceCode: string,
    languageId: string,
  ): Promise<Tree | null> {
    try {
      await this.ensureInitialized();
      if (!this.parser) return null;

      const language = await this.getLanguage(languageId);
      if (!language) return null;

      this.parser.setLanguage(language);
      return this.parser.parse(sourceCode);
    } catch (error) {
      console.error("[TreeSitterService] Parse failed:", error);
      return null;
    }
  }

  // ========== 字段类型提取 ==========

  /**
   * 从 AST 中提取字段类型
   *
   * @param tree        - 语法树
   * @param lineNumber  - 字段所在行（0-based）
   * @returns 类型字符串（如 "int", "num", "std::vector<int>"），失败返回 null
   */
  extractFieldType(tree: Tree, lineNumber: number): string | null {
    try {
      const node = this.findNodeAtLine(tree, lineNumber);
      if (!node) return null;

      // 向上查找字段声明节点
      const declNode = this.walkUpToType(node, FIELD_DECLARATION_TYPES);
      if (!declNode) return null;

      // 获取 type 子节点
      const typeNode = declNode.childForFieldName("type");
      if (typeNode) {
        return typeNode.text;
      }

      // Python 的 annotated_assignment 用 annotation 而非 type
      const annotationNode = declNode.childForFieldName("annotation");
      if (annotationNode) {
        return annotationNode.text;
      }

      return null;
    } catch {
      return null;
    }
  }

  // ========== 方法签名提取 ==========

  /**
   * 从 AST 中提取方法参数和返回类型
   *
   * @param tree        - 语法树
   * @param lineNumber  - 方法所在行（0-based）
   * @returns { params, returnType }，失败返回 null
   */
  extractMethodSignature(
    tree: Tree,
    lineNumber: number,
  ): { params: string; returnType: string } | null {
    try {
      const node = this.findNodeAtLine(tree, lineNumber);
      if (!node) return null;

      // 向上查找方法声明节点
      const declNode = this.walkUpToType(node, METHOD_DECLARATION_TYPES);
      if (!declNode) return null;

      // --- 返回类型 ---
      let returnType = "";
      const typeNode = declNode.childForFieldName("type");
      if (typeNode) {
        returnType = this.cleanReturnType(typeNode.text);
      }

      // Python / Rust 用 return_type 字段
      if (!returnType) {
        const rtNode = declNode.childForFieldName("return_type");
        if (rtNode) returnType = this.cleanReturnType(rtNode.text);
      }

      // Go 用 result 字段
      if (!returnType) {
        const resultNode = declNode.childForFieldName("result");
        if (resultNode) returnType = resultNode.text;
      }

      // --- 参数列表 ---
      let params = "";

      // 直接查找 parameters 字段（Java/TS/JS/Python/Go/Rust）
      const paramsNode = declNode.childForFieldName("parameters");
      if (paramsNode) {
        params = this.stripParens(paramsNode.text);
      }

      // C++ 的参数在 declarator → function_declarator → parameters 中
      if (!params) {
        const declarator = declNode.childForFieldName("declarator");
        if (declarator) {
          // function_declarator 有 parameters 字段
          const innerParams = declarator.childForFieldName("parameters");
          if (innerParams) {
            params = this.stripParens(innerParams.text);
          }
        }
      }

      return { params, returnType };
    } catch {
      return null;
    }
  }

  // ========== 辅助方法 ==========

  /** 查找指定行的最小 AST 节点 */
  private findNodeAtLine(tree: Tree, lineNumber: number): Node | null {
    return tree.rootNode.descendantForPosition(
      { row: lineNumber, column: 0 },
      { row: lineNumber, column: 0 },
    );
  }

  /** 从当前节点向上查找匹配类型的祖先节点 */
  private walkUpToType(
    node: Node,
    types: ReadonlySet<string>,
  ): Node | null {
    let current: Node | null = node;
    while (current) {
      if (types.has(current.type)) {
        return current;
      }
      current = current.parent;
    }
    return null;
  }

  /** 去除参数列表外层括号 */
  private stripParens(text: string): string {
    let result = text.trim();
    if (result.startsWith("(") && result.endsWith(")")) {
      result = result.slice(1, -1).trim();
    }
    return result;
  }

  /**
   * 清理返回类型文本
   * TypeScript 的 type_annotation 包含前导 ":"，需要去除
   */
  private cleanReturnType(text: string): string {
    return text.replace(/^:\s*/, "").trim();
  }
}
