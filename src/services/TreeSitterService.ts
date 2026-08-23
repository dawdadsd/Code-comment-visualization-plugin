/**
 * TreeSitterService.ts - 基于 web-tree-sitter 的语法分析服务
 *
 * **职责：**
 * 1. 管理 web-tree-sitter 解析器引擎的生命周期
 * 2. 按需加载各语言的 WASM grammar 文件
 * 3. 提供从 AST 提取字段类型 / 方法签名的能力
 *
 * **设计原则：**
 * - 懒加载：首次调用时才初始化引擎和加载 grammar
 * - 缓存：已加载的 language 会被缓存
 * - 健壮性：任何异常返回 null，调用方回退到文本解析
 *
 * @author xiaowu
 * @since 2026/08/05
 */

import * as vscode from "vscode";
import type { DocumentSymbol } from "vscode";
// web-tree-sitter 0.20.x 以 export = Parser 导出（Parser 类 + 命名空间类型），
// 类型只能通过 default import 引用；Parser.Language / Parser.Tree / Parser.SyntaxNode
// 是命名空间成员（与 0.26+ 的具名导出结构不同），故统一走类型别名屏蔽版本差异。
import type TreeSitter from "web-tree-sitter";
import * as path from "path";
import * as fs from "fs";

// ========== web-tree-sitter 类型别名 ==========
type Parser = TreeSitter;
type Language = TreeSitter.Language;
type Tree = TreeSitter.Tree;
type SyntaxNode = TreeSitter.SyntaxNode;

// ========== 动态模块加载 ==========

/**
 * 动态加载 web-tree-sitter 模块
 * 优先从 node_modules 加载（开发环境），回退到 media/lib（VSIX 环境）
 *
 * 注意版本差异：0.26+ 的模块导出命名对象 { Parser, Language, ... }，
 * 而 0.20.x 直接导出 Parser 类本身（静态方法 init、静态属性 Language）。
 * 这里统一规范化为 { Parser, Language } 结构，屏蔽版本差异。
 */
function loadWebTreeSitter(): {
  Parser: typeof import("web-tree-sitter");
  Language: typeof import("web-tree-sitter").Language;
} | null {
  const normalize = (raw: unknown) => {
    const mod = raw as {
      Parser?: unknown;
      Language?: unknown;
      init?: unknown;
    };
    const Parser = (mod.Parser ?? mod) as typeof import("web-tree-sitter");
    // 0.20.x 的 Language 是在 Parser.init() 调用时才挂载到 Parser 上的静态属性，
    // 这里通过 getter 延迟读取，避免模块加载时取到 undefined
    return {
      Parser,
      get Language(): typeof import("web-tree-sitter").Language {
        const staticLang = (
          Parser as unknown as {
            Language?: typeof import("web-tree-sitter").Language;
          }
        ).Language;
        return (
          staticLang ??
          (mod.Language as typeof import("web-tree-sitter").Language)
        );
      },
    };
  };
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("web-tree-sitter");
    console.log("[TreeSitterService] Loaded web-tree-sitter from node_modules");
    return normalize(mod);
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
      return normalize(mod);
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

export { LANGUAGE_WASM_MAP };

// ========== AST 节点类型集合 ==========

/** 字段声明节点类型（跨语言） */
const FIELD_DECLARATION_TYPES = new Set([
  "field_declaration", // C++, Java, Rust
  "field_definition", // 部分语法
  "public_field_definition", // TypeScript
  "variable_declarator", // JavaScript (const x = ...)
  "var_spec", // Go
  "annotated_assignment", // Python（旧版本节点名）
  "assignment", // Python (count: int = 0，0.20 grammar 节点名)
  "property_signature", // TS/TSX interface 属性签名（id: number）
  "abstract_property_signature", // TS/TSX 抽象类抽象属性（abstract id: number）
  "property_declaration", // C#、Kotlin 属性（string Name { get; } / val id: Int）
  "constant_declaration", // Java 接口/注解常量（int MAX = 10;）
]);

/**
 * 字段声明内的 declarator 节点类型。
 * 用于识别同一声明中的多个变量（C/C++ 的 size_t l, r, mid; 等），
 * 类型子节点之外的这些节点各对应一个变量，需拆分为独立字段符号。
 */
const FIELD_DECLARATOR_TYPES = new Set([
  "field_declarator",
  "pointer_declarator", // C/C++ 裸指针 int *ptr
  "reference_declarator",
  "array_declarator",
  "function_declarator", // C/C++ 函数指针 / 纯虚函数声明
  "parenthesized_declarator",
  "variable_declarator", // C# 等
  "field_identifier", // 类体/结构体内简单声明（C/C++/Go 直接以标识符为 declarator）
  "identifier", // 全局/局部简单声明（C/C++ 类体外：int *a, b; 中 b）
  "init_declarator", // C 全局带初始化器：int x = 1, y = 2;
]);

/** 指针/引用声明符节点类型（前缀并入类型：int *ptr / int &ref / int&& rref） */
const POINTER_LIKE_DECLARATOR_TYPES = new Set([
  "pointer_declarator",
  "reference_declarator",
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
  "method_signature", // TypeScript/TypeScriptReact interface 内方法签名
  "constructor_signature", // TypeScript 构造签名
  "construct_signature", // TypeScript construct 签名
]);

/** 名称节点类型（标识符/名字，用于从 declarator 结构提取成员名） */
const IDENTIFIER_NODE_TYPES = new Set([
  "identifier",
  "field_identifier",
  "property_identifier",
  "shorthand_property_identifier",
  "type_identifier",
  "variable_name",
  "field_name",
  "statement_identifier",
  "class_identifier",
  "simple_identifier", // Kotlin / Swift
]);

// ========== 语言特征配置表 ==========

/**
 * 语言特征配置
 *
 * 设计目标：把所有语言在 AST 上的差异收敛到这一张表，不拆分解析器。
 * tree-sitter 各语言 grammar 的节点命名高度统一（同源于 tree-sitter 项目），
 * 因此 AST 成员提取只需「一套通用遍历逻辑 + 这张表」即可覆盖所有语言——
 * 既没有浪费 tree-sitter 的解析能力，又避免了每个语言一套重复代码。
 */
export interface LanguageFeature {
  /** 类型声明节点（类/接口/枚举/结构体/协议等） */
  readonly typeNodeTypes: readonly string[];
  /** 方法/构造函数节点 */
  readonly methodNodeTypes: readonly string[];
  /** 字段节点 */
  readonly fieldNodeTypes: readonly string[];
  /** 枚举常量节点 */
  readonly enumMemberNodeTypes: readonly string[];
}

/**
 * 各语言特征配置
 *
 * 仅收录「该语言中能被识别为类型/成员」的节点类型；
 * 未在表中的语言不参与 AST 成员提取，由 LSP 符号主链路兜底。
 */
export const LANGUAGE_FEATURES: Readonly<Record<string, LanguageFeature>> = {
  java: {
    typeNodeTypes: [
      "class_declaration",
      "interface_declaration",
      "enum_declaration",
      "record_declaration",
      "annotation_type_declaration",
    ],
    methodNodeTypes: ["method_declaration", "constructor_declaration"],
    fieldNodeTypes: ["field_declaration", "constant_declaration"], // 接口/注解常量用 constant_declaration
    enumMemberNodeTypes: ["enum_constant"],
  },
  typescript: {
    typeNodeTypes: [
      "class_declaration",
      "interface_declaration",
      "enum_declaration",
      "abstract_class_declaration",
    ],
    methodNodeTypes: [
      "method_definition",
      "function_declaration",
      "arrow_function",
      "function_expression",
      "generator_function_declaration",
      "method_signature", // interface 内的方法签名（无函数体）
      "abstract_method_signature", // 抽象类中的抽象方法签名（无函数体）
      "constructor_signature",
      "construct_signature",
    ],
    fieldNodeTypes: [
      "public_field_definition",
      "field_definition",
      "property_signature", // interface 内的属性签名
      "abstract_property_signature", // 抽象类中的抽象属性签名
    ],
    enumMemberNodeTypes: ["enum_assignment"],
  },
  typescriptreact: {
    typeNodeTypes: [
      "class_declaration",
      "interface_declaration",
      "enum_declaration",
      "abstract_class_declaration",
    ],
    methodNodeTypes: [
      "method_definition",
      "function_declaration",
      "arrow_function",
      "function_expression",
      "generator_function_declaration",
      "method_signature", // interface 内的方法签名（无函数体）
      "abstract_method_signature", // 抽象类中的抽象方法签名（无函数体）
      "constructor_signature",
      "construct_signature",
    ],
    fieldNodeTypes: [
      "public_field_definition",
      "field_definition",
      "property_signature", // interface 内的属性签名
      "abstract_property_signature", // 抽象类中的抽象属性签名
    ],
    enumMemberNodeTypes: ["enum_assignment"],
  },
  javascript: {
    typeNodeTypes: ["class_declaration"],
    methodNodeTypes: [
      "method_definition",
      "function_declaration",
      "arrow_function",
      "function_expression",
      "generator_function_declaration",
    ],
    fieldNodeTypes: ["field_definition", "public_field_definition"],
    enumMemberNodeTypes: [],
  },
  javascriptreact: {
    typeNodeTypes: ["class_declaration"],
    methodNodeTypes: [
      "method_definition",
      "function_declaration",
      "arrow_function",
      "function_expression",
      "generator_function_declaration",
    ],
    fieldNodeTypes: ["field_definition", "public_field_definition"],
    enumMemberNodeTypes: [],
  },
  python: {
    typeNodeTypes: ["class_definition"],
    methodNodeTypes: ["function_definition"],
    // 0.20 grammar 中带类型注解的赋值节点名为 assignment（旧版为 annotated_assignment）
    fieldNodeTypes: ["assignment", "annotated_assignment"],
    enumMemberNodeTypes: [],
  },
  go: {
    typeNodeTypes: ["type_spec"],
    methodNodeTypes: ["method_declaration", "function_declaration"],
    fieldNodeTypes: ["field_declaration"],
    enumMemberNodeTypes: [],
  },
  rust: {
    typeNodeTypes: [
      "struct_item",
      "enum_item",
      "trait_item",
      "impl_item",
      "type_item",
      "union_item",
    ],
    methodNodeTypes: ["function_item", "function_signature_item"], // trait 内无函数体的方法声明为 function_signature_item
    fieldNodeTypes: ["field_declaration"],
    enumMemberNodeTypes: ["enum_variant"],
  },
  c: {
    typeNodeTypes: ["struct_specifier", "union_specifier", "enum_specifier"],
    methodNodeTypes: ["function_definition"],
    fieldNodeTypes: ["field_declaration"],
    enumMemberNodeTypes: ["enumerator"],
  },
  cpp: {
    typeNodeTypes: [
      "class_specifier",
      "struct_specifier",
      "union_specifier",
      "enum_specifier",
    ],
    methodNodeTypes: [
      "function_definition",
      "constructor_definition",
      "destructor_definition",
    ],
    fieldNodeTypes: ["field_declaration"],
    enumMemberNodeTypes: ["enumerator"],
  },
  csharp: {
    typeNodeTypes: [
      "class_declaration",
      "interface_declaration",
      "struct_declaration",
      "enum_declaration",
      "record_declaration",
    ],
    methodNodeTypes: [
      "method_declaration",
      "constructor_declaration",
      "destructor_declaration",
    ],
    fieldNodeTypes: ["field_declaration", "property_declaration"],
    enumMemberNodeTypes: ["enum_member_declaration"],
  },
  php: {
    typeNodeTypes: [
      "class_declaration",
      "interface_declaration",
      "trait_declaration",
      "enum_declaration",
    ],
    methodNodeTypes: ["method_declaration", "function_definition"],
    fieldNodeTypes: ["property_declaration"],
    enumMemberNodeTypes: ["enum_case"],
  },
  ruby: {
    typeNodeTypes: ["class", "module"],
    methodNodeTypes: ["method", "singleton_method"],
    fieldNodeTypes: [],
    enumMemberNodeTypes: [],
  },
  kotlin: {
    typeNodeTypes: [
      "class_declaration",
      "interface_declaration",
      "object_declaration",
    ],
    methodNodeTypes: [
      "function_declaration",
      "primary_constructor",
      "secondary_constructor",
    ],
    fieldNodeTypes: ["property_declaration"],
    enumMemberNodeTypes: ["enum_entry"],
  },
  swift: {
    typeNodeTypes: [
      "class_declaration",
      "protocol_declaration",
      "struct_declaration",
      "enum_declaration",
      "extension_declaration",
      "actor_declaration",
    ],
    methodNodeTypes: [
      "function_declaration",
      "protocol_function_declaration", // protocol 内的方法
      "init_declaration", // Swift 构造器
      "deinit_declaration",
    ],
    fieldNodeTypes: ["property_declaration"],
    enumMemberNodeTypes: ["enum_entry"],
  },
  scala: {
    typeNodeTypes: [
      "class_definition",
      "trait_definition",
      "object_definition",
      "enum_definition",
    ],
    methodNodeTypes: ["function_definition", "constructor_definition"],
    fieldNodeTypes: ["val_definition", "var_definition"],
    enumMemberNodeTypes: [],
  },
  "objective-c": {
    typeNodeTypes: [
      "class_interface",
      "class_implementation",
      "protocol_declaration",
      "category_interface",
      "category_implementation",
    ],
    methodNodeTypes: ["method_declaration"],
    fieldNodeTypes: ["property_declaration", "ivar_declaration"],
    enumMemberNodeTypes: [],
  },
};

// ========== 跨语言集合 ==========

/** 汇总所有语言配置中的类型节点类型（用于「外层类型」查找，覆盖全部已配置语言） */
const ALL_TYPE_NODE_TYPES: ReadonlySet<string> = new Set(
  Object.values(LANGUAGE_FEATURES).flatMap((f) => f.typeNodeTypes),
);

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
   * 开发环境：node_modules/web-tree-sitter/tree-sitter.wasm（0.20.x 文件名）
   * VSIX 环境：media/lib/web-tree-sitter.wasm
   */
  private locateEngineWasm(): string | null {
    const candidates = [
      path.join(
        __dirname, "..", "..",
        "node_modules", "web-tree-sitter", "tree-sitter.wasm",
      ),
      path.join(
        __dirname, "..", "..",
        "node_modules", "web-tree-sitter", "web-tree-sitter.wasm",
      ),
      path.join(__dirname, "..", "..", "media", "lib", "web-tree-sitter.wasm"),
      path.join(__dirname, "..", "..", "media", "lib", "tree-sitter.wasm"),
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
   * @param column      - 字段起始列（0-based）。同行存在多个变量声明时
   *                       （Seg seg; Tag tag;）按行定位会命中第一个声明，
   *                       传入列号可从对应变量的位置向上定位到所属声明。
   * @returns 类型字符串（如 "int", "num", "std::vector<int>"），失败返回 null
   */
  extractFieldType(
    tree: Tree,
    lineNumber: number,
    column?: number,
  ): string | null {
    try {
      const node =
        column === undefined || column < 0
          ? this.findNodeAtLine(tree, lineNumber)
          : this.findNodeAtPosition(tree, lineNumber, column);
      if (!node) return null;

      // 向上查找字段声明节点
      const declNode = this.walkUpToType(node, FIELD_DECLARATION_TYPES);
      if (!declNode) return null;

      // 获取 type 子节点
      const typeNode = declNode.childForFieldName("type");
      if (typeNode) {
        // TS/TSX 的属性签名（property_signature / abstract_property_signature）
        // 类型字段值是 type_annotation（文本含 ": " 前缀），取其内部类型子节点：
        // 部分 grammar 版本以 "type" 命名字段承载，其余版本直接为唯一具名子节点
        const effectiveTypeNode =
          typeNode.type === "type_annotation"
            ? (typeNode.childForFieldName("type") ??
               typeNode.namedChildren[0] ??
               typeNode)
            : typeNode;
        let result = effectiveTypeNode.text;
        // C 系类型修饰符（const 等 type_qualifier）是 declaration 的直接子节点，
        // 不在 type 字段内（const int *p → type 仅为 int），并入类型前缀
        const qualifiers = declNode.namedChildren.filter(
          (c) => c.type === "type_qualifier",
        );
        if (qualifiers.length > 0) {
          result = `${qualifiers.map((q) => q.text).join(" ")} ${result}`;
        }
        // C/C++/Objective-C 的指针/引用在 declarator 中（int *ptr / int &ref →
        // pointer_declarator / reference_declarator），需并入类型，否则指针/引用
        // 信息丢失。同一行多个声明符（int *a, b;）各 declarator 自带指针，
        // 故从定位点向上找所属的 pointer/reference declarator，精确归属到单变量
        let current: SyntaxNode | null = node;
        let pointerText = "";
        while (current && current !== declNode) {
          if (POINTER_LIKE_DECLARATOR_TYPES.has(current.type)) {
            pointerText = this.declaratorPrefixTextOf(current);
            break;
          }
          current = current.parent;
        }
        // 定位点落在类型上（AST 兜底的单一声明，无列号指向变量名）时向上找不到
        // declarator，回退扫描声明内的指针/引用 declarator。
        // 仅当整个声明只有一个 declarator 时安全回退；多 declarator
        // （int *a, b;）无法区分指针归属哪个变量，不猜测（b 保持纯类型 int）
        if (
          !pointerText &&
          declNode.namedChildren.filter((c) =>
            FIELD_DECLARATOR_TYPES.has(c.type),
          ).length <= 1
        ) {
          const pointerDecls = declNode.descendantsOfType(
            Array.from(POINTER_LIKE_DECLARATOR_TYPES),
          );
          if (pointerDecls.length === 1) {
            pointerText = this.declaratorPrefixTextOf(pointerDecls[0]!);
          }
        }
        if (pointerText) {
          result = `${result} ${pointerText}`;
        }
        return result;
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

  // ========== AST 成员提取（LSP 符号兜底） ==========

  /**
   * 从 AST 中提取类型/方法/字段/枚举成员，构造与 LSP 同形状的 DocumentSymbol 树。
   *
   * 用途：当 Language Server 不可用（未装语言扩展 / 文件不在 workspace）导致
   * resolveSymbols 返回空时，由 DocCommentParser 调用本方法兜底，
   * 输出的符号树可直接喂给既有解析链路（flattenSymbols / collectTypeGroups）。
   *
   * 遍历逻辑对全部语言通用：按类型节点递归，方法/字段/枚举常量收集到当前类型下，
   * 非成员容器节点（program / class_body / export_statement 等）透传继续下钻。
   *
   * @param tree        - 语法树
   * @param languageId  - 语言 ID（决定使用哪张特征配置）
   * @returns 顶层符号树，语言不受支持或解析失败时返回空数组
   */
  extractMembers(tree: Tree, languageId: string): DocumentSymbol[] {
    const feature = LANGUAGE_FEATURES[languageId];
    if (!feature) return [];

    const sets = {
      type: new Set(feature.typeNodeTypes),
      method: new Set(feature.methodNodeTypes),
      field: new Set(feature.fieldNodeTypes),
      enum: new Set(feature.enumMemberNodeTypes),
    };
    const result: DocumentSymbol[] = [];
    try {
      this.walkMembers(tree.rootNode, sets, result);
    } catch (error) {
      console.error("[TreeSitterService] extractMembers failed:", error);
      return [];
    }
    return result;
  }

  /**
   * 深度优先遍历 AST，把类型/成员节点转换为 DocumentSymbol 收集到 out 中。
   *
   * @param node   - 当前节点
   * @param sets   - 该语言的节点类型集合
   * @param out    - 收集容器（类型节点递归时传入其自身的 children）
   * @param inEnum - 是否位于枚举容器内（用于识别 TS 无值枚举成员 property_identifier，
   *                避免该节点类型在对象字面量等场景下被误收集）
   */
  private walkMembers(
    node: SyntaxNode,
    sets: {
      readonly type: ReadonlySet<string>;
      readonly method: ReadonlySet<string>;
      readonly field: ReadonlySet<string>;
      readonly enum: ReadonlySet<string>;
    },
    out: DocumentSymbol[],
    inEnum = false,
  ): void {
    for (const child of node.namedChildren) {
      if (sets.type.has(child.type)) {
        // 类型声明（类/接口/枚举）→ 递归收集其内部成员，支持嵌套类型
        const symbol = this.buildTypeSymbol(child);
        const isEnumContainer =
          this.kindForTypeNode(child) === vscode.SymbolKind.Enum;
        this.walkMembers(child, sets, symbol.children, isEnumContainer);
        out.push(symbol);
      } else if (sets.method.has(child.type)) {
        // 方法节点可能是变量的值（const f = () => {} / export const f = function() {}）：
        // 箭头函数/函数表达式自身没有 name 字段，名称应取外层变量声明的变量名，
        // 与 LSP 的 isFunctionVariableSymbol 行为保持一致
        const varParent = this.findVariableDeclaratorParent(child);
        out.push(
          varParent
            ? this.buildFunctionVariableSymbol(varParent, child)
            : this.buildMethodSymbol(child),
        );
      } else if (sets.enum.has(child.type) || (inEnum && this.isEnumMemberNode(child))) {
        out.push(this.buildEnumMemberSymbol(child));
      } else if (sets.field.has(child.type)) {
        // JS/TS：字段节点若持有函数（如 const f = () => {}），按方法收集，
        // 与 LSP 的 isFunctionVariableSymbol 行为保持一致
        const fn = this.findMethodDescendant(child, sets.method);
        if (fn) {
          out.push(this.buildFunctionVariableSymbol(child, fn));
        } else {
          // 同行多声明变量（size_t l, r, mid;）可能拆分出多个字段符号
          out.push(...this.buildFieldSymbol(child));
        }
      } else if (
        child.type === "lexical_declaration" ||
        child.type === "variable_declaration"
      ) {
        // 模块级 const/let/var 变量（const x = Object.freeze({...}) 等）→
        // 作为散落字段收集。仅处理父级为 program / export_statement 的声明：
        // 语句块内的局部变量（for / if 等）不是模块成员，不得收集。
        // 变量持有函数（const f = () => {}）时按方法收集，与 field 分支一致。
        const parentType = child.parent?.type;
        if (
          parentType !== "program" &&
          parentType !== "export_statement"
        ) {
          continue;
        }
        for (const decl of child.namedChildren) {
          if (decl.type !== "variable_declarator") continue;
          const fn = this.findMethodDescendant(decl, sets.method);
          if (fn) {
            out.push(this.buildFunctionVariableSymbol(decl, fn));
          } else {
            out.push(...this.buildFieldSymbol(decl));
          }
        }
      } else {
        // 非成员容器（program / class_body / export_statement 等）→ 透传下钻
        // 跳过类型参数子树（泛型约束里的属性签名/类型声明不属于成员）
        if (
          child.type === "type_parameters" ||
          child.type === "type_parameter_list"
        ) {
          continue;
        }
        this.walkMembers(child, sets, out, inEnum);
      }
    }
  }

  /**
   * 枚举成员节点判定：仅当位于枚举容器内时才识别。
   * - enum_assignment：TS/JS 带值枚举（MALE = 1）专用节点，不会出现在别处
   * - property_identifier：TS/JS 无值枚举成员（MALE,）
   */
  private isEnumMemberNode(node: SyntaxNode): boolean {
    return (
      node.type === "enum_assignment" || node.type === "property_identifier"
    );
  }

  /** 构造类型符号（Class/Interface/Enum/Struct），detail 为空（类型卡片不展示签名） */
  private buildTypeSymbol(node: SyntaxNode): DocumentSymbol {
    const range = this.nodeRange(node);
    const symbol = new vscode.DocumentSymbol(
      this.nodeName(node),
      "",
      this.kindForTypeNode(node),
      range,
      this.nameRange(node) ?? range,
    );
    symbol.children = [];
    return symbol;
  }

  /** 构造方法/构造函数符号，detail 为签名文本（供 parseMethod 展示） */
  private buildMethodSymbol(node: SyntaxNode): DocumentSymbol {
    const range = this.nodeRange(node);
    const kind = this.kindForMethodNode(node);
    const symbol = new vscode.DocumentSymbol(
      // 构造函数：LSP 约定符号名为类名（TS/JS 的 method_definition 名是
      // 字面量 constructor），故取外层类型节点名；Java/C++ 等专用节点名本就是类名
      kind === vscode.SymbolKind.Constructor
        ? (this.constructorTypeName(node) ?? this.nodeName(node))
        : this.nodeName(node),
      this.signatureDetail(node),
      kind,
      range,
      this.nameRange(node) ?? range,
    );
    symbol.children = [];
    return symbol;
  }

  /**
   * 构造字段符号，detail 为声明文本（供 parseField 类型推断回退）。
   *
   * C/C++/Objective-C/Go/C# 等语法允许在同一行声明多个变量
   * （size_t l, r, mid; / num MUL, ADD; / SegTree *ls, *rs;），
   * 语法树中一个 field_declaration 含 type 子节点 + 多个 declarator 子节点，
   * 此时为每个 declarator 生成独立的字段符号，名称/范围/类型均对应单个变量。
   */
  private buildFieldSymbol(node: SyntaxNode): DocumentSymbol[] {
    // 同行多声明变量拆分：type 之后的 declarator 类子节点各为一个变量
    const typeNode = node.childForFieldName("type");
    const declarators = typeNode
      ? node.namedChildren.filter((c) =>
          FIELD_DECLARATOR_TYPES.has(c.type),
        )
      : [];
    if (declarators.length > 1) {
      return declarators.map((decl) => {
        const range = this.nodeRange(decl);
        const nameNode = this.findNameNode(decl);
        const symbol = new vscode.DocumentSymbol(
          nameNode?.text ?? this.nodeName(decl),
          decl.text.replace(/\s+/g, " ").trim(),
          vscode.SymbolKind.Field,
          range,
          nameNode ? this.nodeRange(nameNode) : range,
        );
        symbol.children = [];
        return symbol;
      });
    }

    // 单一声明：维持既有行为（整个声明为一个符号）
    const range = this.nodeRange(node);
    const symbol = new vscode.DocumentSymbol(
      this.nodeName(node),
      node.text.replace(/\s+/g, " ").trim(),
      vscode.SymbolKind.Field,
      range,
      this.nameRange(node) ?? range,
    );
    symbol.children = [];
    return [symbol];
  }

  /** 构造枚举常量符号 */
  private buildEnumMemberSymbol(node: SyntaxNode): DocumentSymbol {
    const range = this.nodeRange(node);
    const symbol = new vscode.DocumentSymbol(
      this.nodeName(node),
      node.text.replace(/\s+/g, " ").trim(),
      vscode.SymbolKind.EnumMember,
      range,
      this.nameRange(node) ?? range,
    );
    symbol.children = [];
    return symbol;
  }

  /**
   * 构造「变量持有函数」的方法符号（JS/TS 的 const f = () => {} 场景）。
   * 名称取自变量声明，签名取自其内部的函数节点。
   */
  private buildFunctionVariableSymbol(
    variableNode: SyntaxNode,
    fnNode: SyntaxNode,
  ): DocumentSymbol {
    const range = this.nodeRange(variableNode);
    const symbol = new vscode.DocumentSymbol(
      this.nodeName(variableNode),
      this.signatureDetail(fnNode),
      this.kindForMethodNode(fnNode),
      range,
      this.nameRange(variableNode) ?? range,
    );
    symbol.children = [];
    return symbol;
  }

  /** 在节点子树中查找第一个匹配的方法节点（不含自身） */
  private findMethodDescendant(
    node: SyntaxNode,
    methodSet: ReadonlySet<string>,
  ): SyntaxNode | null {
    const stack: SyntaxNode[] = [...node.namedChildren];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (methodSet.has(current.type)) {
        return current;
      }
      stack.push(...current.namedChildren);
    }
    return null;
  }

  /**
   * 查找包裹当前节点（作为变量值）的 variable_declarator 祖先。
   * 用于「变量持有函数」场景（const f = () => {}），使方法名称取自变量名。
   * 只允许经过声明容器（lexical_declaration / export_statement 等），
   * 一旦跨越 program / class_body 边界即放弃，避免误配到其他声明。
   */
  private findVariableDeclaratorParent(
    node: SyntaxNode,
  ): SyntaxNode | null {
    let current = node.parent;
    while (current) {
      if (current.type === "variable_declarator") {
        return current;
      }
      if (
        current.type === "program" ||
        current.type === "class_body" ||
        current.type === "statement_block"
      ) {
        return null;
      }
      current = current.parent;
    }
    return null;
  }

  /** 提取节点名称：优先 name 字段，其次 declarator 下的名称节点，回退为文本中第一个标识符 */
  private nodeName(node: SyntaxNode): string {
    // Rust impl 块：类型名在 type 字段（impl<T> LinkedList<T>）
    if (node.type === "impl_item") {
      const implType = node.childForFieldName("type");
      if (implType) {
        const name = this.findNameNode(implType);
        if (name) return name.text;
      }
    }
    const nameNode = node.childForFieldName("name");
    if (nameNode) return nameNode.text;
    // 声明节点（Java/C 字段、C 方法等）：名称位于 declarator 子树的 identifier 类节点中。
    // 例：Java "private Long id" 的 declarator 是 variable_declarator(id)，
    //     C "User *findById(...)" 的 declarator 是 function_declarator(identifier findById)
    const declarator = node.childForFieldName("declarator");
    const declName = declarator ? this.findNameNode(declarator) : null;
    if (declName) return declName.text;
    // 回退：扫描直接子节点中的标识符节点（JS/Python 字段等没有 name/declarator 字段的声明）
    // 例：JS "static count = 0" 的 namedChildren = [static, property_identifier(count), ...]，
    //     Python "count: int = 0" 的 namedChildren = [identifier(count), type, integer]
    for (const child of node.namedChildren) {
      if (IDENTIFIER_NODE_TYPES.has(child.type)) return child.text;
    }
    // 全子树查找：C# 等语言 declarator 嵌套在 variable_declaration 中，
    // Objective-C property 名称嵌套在 struct_declaration → struct_declarator 中
    const scanned = this.findNameNode(node);
    if (scanned) return scanned.text;
    const match = /[A-Za-z_$][\w$]*/.exec(node.text);
    return match ? match[0] : "";
  }

  /**
   * 在子树中查找名称节点：优先自身/子节点的 name 字段与 identifier 类节点。
   * 用于 declarator 结构（int *ptr / User *findById(...)）下的名称提取。
   * 跳过 parameters 子树，避免函数声明中参数名被误当方法名。
   */
  private findNameNode(node: SyntaxNode | null): SyntaxNode | null {
    if (!node) return null;
    // C++ 运算符重载：operator_name 节点文本即完整运算符名（operator+ 等）
    if (node.type === "operator_name") {
      return node;
    }
    if (IDENTIFIER_NODE_TYPES.has(node.type) && node.type !== "type_identifier") {
      return node;
    }
    const nameNode = node.childForFieldName("name");
    if (nameNode) return nameNode;
    // declarator 优先于其他 identifier（避免 C# 等嵌套声明中 type_identifier 被当名字）
    const declarator = node.childForFieldName("declarator");
    if (declarator) {
      const declName = this.findNameNode(declarator);
      if (declName) return declName;
    }
    // 名称类标识符（identifier/property_identifier 等）优先；type_identifier 降级，
    // 仅当全树找不到名称时兜底（如 Rust impl 的 generic_type）
    let typeCandidate: SyntaxNode | null = null;
    const stack: SyntaxNode[] = [...node.namedChildren];
    while (stack.length > 0) {
      const cur = stack.pop();
      if (!cur) continue;
      if (cur.type === "parameters" || cur.type === "parameter_list") {
        continue;
      }
      if (cur.type === "type_identifier") {
        typeCandidate = cur;
        continue;
      }
      if (cur.type === "operator_name") {
        return cur;
      }
      if (IDENTIFIER_NODE_TYPES.has(cur.type)) return cur;
      stack.push(...cur.namedChildren);
    }
    return typeCandidate;
  }

  /**
   * 生成方法签名文本（detail）：
   * 取节点起始到参数列表结束的文本，跨行签名完整保留、不含方法体；
   * 无 parameters 字段的语言（个别 grammar）回退为第一个 { 之前的文本。
   */
  private signatureDetail(node: SyntaxNode): string {
    try {
      const paramsNode = node.childForFieldName("parameters");
      const endIndex = paramsNode
        ? paramsNode.endIndex - node.startIndex
        : node.text.length;
      let sig = node.text.slice(0, Math.max(0, endIndex));
      sig = sig.replace(/\s+/g, " ").trim();
      // 去掉前导注解（Java @Override 等）与尾部残留符号（Python 冒号等）
      sig = sig.replace(/^(?:\s*@[\w.]+(?:\([^)]*\))?)+/, "").trim();
      return sig.replace(/[:;]\s*$/, "").trim();
    } catch {
      return (node.text.split("{")[0] ?? "").replace(/\s+/g, " ").trim();
    }
  }

  /** 类型节点的 SymbolKind：按节点类型关键字映射 */
  private kindForTypeNode(node: SyntaxNode): vscode.SymbolKind {
    const type = node.type;
    if (
      type.includes("interface") ||
      type.includes("protocol") ||
      type.includes("trait")
    ) {
      return vscode.SymbolKind.Interface;
    }
    if (type.includes("enum")) {
      return vscode.SymbolKind.Enum;
    }
    if (type.includes("struct")) {
      return vscode.SymbolKind.Struct;
    }
    // Go 的 type_spec 节点名不含类型关键字，从其 type 字段判定
    if (type === "type_spec") {
      const typeChild = node.childForFieldName("type");
      if (typeChild?.type.includes("interface")) {
        return vscode.SymbolKind.Interface;
      }
      if (typeChild?.type.includes("struct")) {
        return vscode.SymbolKind.Struct;
      }
    }
    return vscode.SymbolKind.Class;
  }

  /** 查找包裹当前节点的最近类型节点名（构造函数取类名时用） */
  private constructorTypeName(node: SyntaxNode): string | null {
    let current = node.parent;
    while (current) {
      if (ALL_TYPE_NODE_TYPES.has(current.type)) {
        return this.nodeName(current);
      }
      current = current.parent;
    }
    return null;
  }

  /** 方法节点的 SymbolKind：构造函数/初始化器 → Constructor，其余为 Method */
  private kindForMethodNode(node: SyntaxNode): vscode.SymbolKind {
    // TS/JS 的构造函数是普通 method_definition，仅名字叫 constructor，
    // 故除节点类型外还需按名称推断（通用规则，不区分语言）
    const name = this.nodeName(node);
    // C/C++ 的构造函数/析构函数统一解析为 function_definition，
    // 其声明名与所属类型同名，据此识别为 Constructor（与 LSP 行为一致）
    const enclosingTypeName = this.constructorTypeName(node);
    return node.type.includes("constructor") ||
      node.type.includes("initializer") ||
      node.type === "init_declaration" || // Swift
      name === "constructor" ||
      (enclosingTypeName !== null && name === enclosingTypeName)
      ? vscode.SymbolKind.Constructor
      : vscode.SymbolKind.Method;
  }

  /** 节点完整范围（0-based 行列） */
  private nodeRange(node: SyntaxNode): vscode.Range {
    return new vscode.Range(
      new vscode.Position(node.startPosition.row, node.startPosition.column),
      new vscode.Position(node.endPosition.row, node.endPosition.column),
    );
  }

  /** 节点 name 字段的范围（selectionRange 用），无 name 字段时返回 null */
  private nameRange(node: SyntaxNode): vscode.Range | null {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return null;
    return new vscode.Range(
      new vscode.Position(
        nameNode.startPosition.row,
        nameNode.startPosition.column,
      ),
      new vscode.Position(
        nameNode.endPosition.row,
        nameNode.endPosition.column,
      ),
    );
  }

  // ========== 辅助方法 ==========

  /** 查找指定行的最小 AST 节点 */
  private findNodeAtLine(tree: Tree, lineNumber: number): SyntaxNode | null {
    const lineText = tree.rootNode.text.split("\n")[lineNumber] ?? "";
    // 跳到行内第一个非空白列：列 0 通常是缩进空白（属于父容器节点），
    // 会使 walkUpToType 找不到方法/字段声明节点（extractMethodSignature 失效）
    const col = lineText.search(/\S/);
    if (col < 0) return null;
    return tree.rootNode.descendantForPosition(
      { row: lineNumber, column: col },
      { row: lineNumber, column: col + 1 },
    );
  }

  /** 查找指定行列的最小 AST 节点（同行多声明时用于精确定位到对应声明） */
  private findNodeAtPosition(
    tree: Tree,
    row: number,
    column: number,
  ): SyntaxNode | null {
    return tree.rootNode.descendantForPosition(
      { row, column },
      { row, column: column + 1 },
    );
  }

  /** 从当前节点向上查找匹配类型的祖先节点 */
  private walkUpToType(
    node: SyntaxNode,
    types: ReadonlySet<string>,
  ): SyntaxNode | null {
    let current: SyntaxNode | null = node;
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
   * 提取声明符的前缀文本（指针 * / 引用 & / &&）。
   *
   * 优先取 pointer/reference 字段，否则按"变量名列号 - 声明符起始列"的
   * 列差取前缀（对 pointer_declarator 与 reference_declarator 均有效）。
   *
   * @param declarator - pointer_declarator / reference_declarator 节点
   * @returns 前缀文本（如 "*", "**", "&", "&&"），无前缀返回空字符串
   */
  private declaratorPrefixTextOf(declarator: SyntaxNode): string {
    const pointerNode = declarator.childForFieldName("pointer");
    if (pointerNode) {
      return pointerNode.text;
    }
    const referenceNode = declarator.childForFieldName("reference");
    if (referenceNode) {
      return referenceNode.text;
    }
    const nameNode = this.findNameNode(declarator);
    if (nameNode) {
      // 指针/引用与变量名同行，列差即前缀长度（字节安全）
      const prefixLen =
        nameNode.startPosition.column - declarator.startPosition.column;
      if (prefixLen > 0) {
        return declarator.text.slice(0, prefixLen).trim();
      }
    }
    return "";
  }

  /**
   * 清理返回类型文本
   * TypeScript 的 type_annotation 包含前导 ":"，需要去除
   */
  private cleanReturnType(text: string): string {
    return text.replace(/^:\s*/, "").trim();
  }
}
