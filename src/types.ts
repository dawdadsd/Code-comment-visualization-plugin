/**
 * types.ts : 定义类型文件集中管理
 *
 * @author xiaowu
 * @since 2026/02/04
 */
import { DocumentSymbol } from "vscode";
/**
 * brand 类型
 * example :
 * function jumpToLine(line : number)
 * function setAge(age : number)
 * jumToLine(25) is true
 * jumToLine(age) is false,but TypeScript not error,because both are number type
 * we can use brand type to solve this problem
 */
declare const _brand: unique symbol;

/**
 * example :Brand<number,'LineNumber'> -> have a LineNumber number type
 */
type Brand<T, B> = T & { readonly [_brand]: B };

export type LineNumber = Brand<number, "LineNumber">;

/**
 * Method unique identity type
 */
export type MethodId = Brand<string, "MethodId">;

/**
 * FilePath type
 */
export type FilePath = Brand<string, "FilePath">;

export const LineNumber = (n: number): LineNumber => n as LineNumber;

export const MethodId = (id: string): MethodId => id as MethodId;

export const FilePath = (path: string): FilePath => path as FilePath;

export const ACCESS_MODIFIERS = [
  "public",
  "protected",
  "private",
  "default",
] as const satisfies readonly string[];

export type AccessModifier = (typeof ACCESS_MODIFIERS)[number];

/**
 * example javadoc — @param id user unique id
 *
 * translates to : {
 *  name : 'id',
 *  type : 'string',
 *  description : 'user unique id'
 * }
 */
export interface ParamTag {
  readonly name: string;
  readonly type: string;
  readonly description: string;
}
/**
 * @return tag data
 */
export interface ReturnTag {
  readonly type: string;
  readonly description: string;
}

/**
 * 异常标签数据（@throws / @exception）
 */
export interface ThrowsTag {
  readonly type: string;
  readonly description: string;
}

/**
 * 类型标签数据（@type，JSDoc）。示例：@type {string}
 */
export interface TypeTag {
  readonly type: string;
  readonly description: string;
}

/**
 * 类型定义标签数据（@typedef，JSDoc）。示例：@typedef {Object} UserName
 */
export interface TypeDefTag {
  readonly name: string;
  readonly type: string;
  readonly description: string;
}

/**
 * 属性标签数据（@property / @prop，JSDoc）。示例：@property {string} name - description
 */
export interface PropertyTag {
  readonly name: string;
  readonly type: string;
  readonly description: string;
}

/**
 * 生成器返回值标签数据（@yields / @yield，JSDoc）。示例：@yields {number} description
 */
export interface YieldsTag {
  readonly type: string;
  readonly description: string;
}

/**
 * 事件标签数据（@emits / @fires / @listens，JSDoc）
 */
export interface EventTag {
  readonly name: string;
  readonly description: string;
}

/**
 * tag tables
 */
export interface TagTable {
  // 已有标签
  readonly params: readonly ParamTag[];
  readonly returns: ReturnTag | null;
  readonly throws: readonly ThrowsTag[];
  readonly since: string | null;
  readonly author: string | null;
  readonly license: string | null;
  readonly deprecated: string | null;
  readonly see: readonly string[];
  readonly doc: string | null;
  readonly example: string | null;
  // JSDoc 扩展标签
  readonly type: TypeTag | null;
  readonly typedef: TypeDefTag | null;
  readonly properties: readonly PropertyTag[];
  readonly template: readonly string[];
  readonly yields: YieldsTag | null;
  readonly summary: string | null;
  readonly description: string | null;
  readonly todo: readonly string[];
  readonly emits: readonly EventTag[];
  readonly listens: readonly EventTag[];
  readonly modifiers: readonly string[];
}

/**
 * Git 作者信息
 */
export interface GitAuthorInfo {
  readonly author: string; // 原始作者
  readonly lastModifier: string; // 最后修改者
  readonly lastModifyDate: string; // 最后修改时间
}

/**
 * 方法类别 —— 区分普通方法和构造函数
 *
 * **为什么需要区分？：**
 * VS Code SymbolKind 中 Method(6) 和 Constructor(9) 是不同的值，
 * 侧边栏需要用不同图标和分组来展示它们
 */
export type MethodKind = "method" | "constructor";

/**
 * 方法文档 - 单个方法的完整信息
 */
export interface MethodDoc {
  readonly id: MethodId; // 唯一标识，格式："方法名_行号"
  readonly kind: MethodKind; // 方法类别：普通方法 or 构造函数
  readonly name: string; // 方法名
  readonly signature: string; // 完整签名，如 "public User findById(Long id)"
  readonly params: string; // 参数列表（从 AST 提取，如 "Long id, String name"）
  readonly returnType: string; // 返回类型（从 AST 提取，如 "User"），构造函数为空
  readonly startLine: LineNumber; // 方法起始行（用于跳转）
  readonly endLine: LineNumber; // 方法结束行（用于判断光标是否在方法内）
  readonly hasComment: boolean; // 是否有 Javadoc 注释
  readonly description: string; // Javadoc 描述部分
  readonly tags: TagTable; // 结构化标签
  readonly belongsTo: string; // 所属类名（内部类场景）
  readonly accessModifier: AccessModifier; // 访问修饰符
  readonly gitInfo?: GitAuthorInfo | undefined; // Git 作者信息（可选）
}
/**
 * 单个类型（类/接口/枚举/结构体）的注释信息
 *
 * 多类型文件中，每个类型有独立的注释和标签，
 * 前端在各自的类型卡片内渲染。
 */
export interface TypeGroupInfo {
  readonly typeName: string; // 类型全名（如 "Foo" 或 "Outer.Inner"）
  readonly comment: string; // 描述部分（已剥离 @tag）
  readonly tags: TagTable; // 结构化标签
  readonly startLine: number; // 类型声明所在行（用于跳转）
  readonly commentStartLine?: number | undefined; // 类型注释起始行（用于滚动锚点，无注释时 undefined）
}

/**
 * 类文档 - 整个 Java 文件的解析结果
 */
export interface ClassDoc {
  readonly className: string; // 类名（文件名，用于标题）
  readonly classComment: string; // 文件级注释（描述部分，已剥离标签）
  readonly classTags: TagTable; // 文件级注释标签
  readonly fileHeaderStartLine?: number | undefined; // 文件头注释起始行（滚动锚点区间，无文件头时 undefined）
  readonly fileHeaderEndLine?: number | undefined; // 文件头注释结束行（滚动锚点区间，无文件头时 undefined）
  readonly typeGroups: readonly TypeGroupInfo[]; // 各类型的注释+标签（多类型文件）
  readonly packageName: string; // 包名
  readonly filePath: FilePath; // 文件路径
  readonly methods: readonly MethodDoc[]; // 方法列表（扁平化，含内部类）
  readonly fields: readonly FieldDoc[]; // 字段列表
  readonly enumConstants: readonly EnumConstantDoc[]; // 枚举常量列表
  readonly gitInfo?: GitAuthorInfo | undefined; // 类的 Git 作者信息（可选）
  readonly docAuthor?: string | undefined; // 文档注释 @author 标签
  readonly docSince?: string | undefined; // 文档注释 @since 标签
  readonly docLicense?: string | undefined; // 文档注释 SPDX / @license 标签
}

/**
 * Extension → Webview 的下行消息
 * updateView : 刷新整个视图
 * highlightMethod : 高亮某个方法
 * clearView : 清空视图
 */
export type DownstreamMessage =
  | { readonly type: "updateView"; readonly payload: ClassDoc }
  | { readonly type: "highlightMethod"; readonly payload: { id: MethodId } }
  | { readonly type: "highlightField"; readonly payload: { line: LineNumber } }
  | { readonly type: "clearHighlight" }
  | { readonly type: "clearView" }
  | {
      readonly type: "updateMarkdown";
      readonly payload: {
        content: string;
        fileName: string;
        imageMap: Readonly<Record<string, string>>;
      };
    }
  | {
      readonly type: "syncScroll";
      readonly payload: {
        topLine: number;
        bottomLine: number;
        totalLines: number;
        /** 视觉中心对应的小数行号（折行时按字符偏移中点计算），侧边栏优先使用 */
        centerLine?: number;
      };
    }
  | {
      readonly type: "setHighlightTheme";
      readonly payload: { readonly dark: string; readonly light: string };
    }
  | { readonly type: "debugInfo"; readonly payload: { content: string } };

/**
 * 字段文档 - 普通字段和常量的信息
 */
export interface FieldDoc {
  readonly name: string;
  readonly type: string;
  readonly signature: string;
  readonly startLine: LineNumber;
  readonly endLine: LineNumber; // 字段结束行（含初始化器，用于判断光标是否在字段内）
  readonly hasComment: boolean;
  readonly description: string;
  readonly tags: TagTable;
  readonly isConstant: boolean;
  readonly accessModifier: AccessModifier;
  readonly belongsTo: string;
}

/**
 * 枚举常量文档 - 独立于 FieldDoc 的类型
 *
 * **为什么不复用 FieldDoc？：**
 * 枚举常量的语法与普通字段完全不同：
 *   - 没有类型声明（类型就是枚举自身）
 *   - 没有访问修饰符（隐式 public static final）
 *   - 可以有构造参数：SUCCESS(200, "OK")
 *   - 用逗号分隔而非分号
 * 强行复用会导致 extractFieldType / extractAccessModifier 产生错误结果
 */
export interface EnumConstantDoc {
  readonly name: string; // 枚举常量名，如 "SUCCESS"
  readonly startLine: LineNumber; // 声明所在行
  readonly endLine: LineNumber; // 枚举常量结束行（含构造参数/分号/逗号）
  readonly hasComment: boolean; // 是否有 Javadoc
  readonly description: string; // Javadoc 描述
  readonly arguments: string; // 构造参数文本，如 "(200, \"OK\")"，无参数则为 ""
  readonly belongsTo: string; // 所属枚举类名
}
/**
 * Webview → Extension 的上行消息
 */
export type UpstreamMessage =
  | { readonly type: "jumpToLine"; readonly payload: { line: LineNumber } } // 跳转到某行
  | { readonly type: "openMarkdownLink"; readonly payload: { href: string } } // 打开 Markdown 本地链接
  | { readonly type: "navigateToSymbol"; readonly payload: { name: string } } // 跳转到文件内符号
  | { readonly type: "scrollEditor"; readonly payload: { line: number } } // 侧边栏滚动同步到编辑器（不移动光标）
  | { readonly type: "webviewReady" } // Webview 加载完成
  | { readonly type: "setViewMode"; readonly payload: { mode: "compact" | "detail" } } // 持久化用户视图模式偏好
  | { readonly type: "__debug"; readonly payload: DebugReportPayload }; // 调试插桩上报（仅调试会话期间存在）

/**
 * 调试插桩上报负载（仅调试会话期间存在）
 */
export type DebugReportPayload = {
  readonly hyp: string; // 假设 ID（A/B/C/D/E）
  readonly loc: string; // 上报位置标识
  readonly msg: string; // 事件描述
  readonly data?: unknown; // 结构化数据
};

/**
 * 类型守卫 - 运行时检查消息是否合法
 *
 * **为什么需要类型守卫？：**
 * postMessage 传来的数据是 unknown 类型（可能是任何东西），
 * 我们需要在运行时验证它确实是 UpstreamMessage。
 * is -> tell TypeScript if true ,value is UpstreamMessage
 */
export function isUpstreamMessage(value: unknown): value is UpstreamMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  // 告诉 TypeScript value 是 Record<string,unknown>
  const msg = value as Record<string, unknown>;
  switch (msg["type"]) {
    case "jumpToLine":
      // jumpToLine 需要有 payload.line 且是数字
      return (
        typeof msg["payload"] === "object" &&
        msg["payload"] !== null &&
        typeof (msg["payload"] as Record<string, unknown>)["line"] === "number"
      );

    case "openMarkdownLink":
      // openMarkdownLink 需要有 payload.href 且是字符串
      return (
        typeof msg["payload"] === "object" &&
        msg["payload"] !== null &&
        typeof (msg["payload"] as Record<string, unknown>)["href"] === "string"
      );

    case "webviewReady":
      return true;

    case "navigateToSymbol":
      return (
        typeof msg["payload"] === "object" &&
        msg["payload"] !== null &&
        typeof (msg["payload"] as Record<string, unknown>)["name"] === "string"
      );

    case "scrollEditor":
      return (
        typeof msg["payload"] === "object" &&
        msg["payload"] !== null &&
        typeof (msg["payload"] as Record<string, unknown>)["line"] === "number"
      );

    case "setViewMode":
      // setViewMode 需要有 payload.mode 且为 "compact" | "detail"
      return (
        typeof msg["payload"] === "object" &&
        msg["payload"] !== null &&
        ((msg["payload"] as Record<string, unknown>)["mode"] === "compact" ||
          (msg["payload"] as Record<string, unknown>)["mode"] === "detail")
      );

    case "__debug":
      // __debug 需要 hyp/loc/msg 均为字符串
      {
        const payload = msg["payload"];
        return (
          typeof payload === "object" &&
          payload !== null &&
          typeof (payload as Record<string, unknown>)["hyp"] === "string" &&
          typeof (payload as Record<string, unknown>)["loc"] === "string" &&
          typeof (payload as Record<string, unknown>)["msg"] === "string"
        );
      }

    default:
      return false;
  }
}

export type SupportedLanguageId =
  | "java"
  | "typescript"
  | "typescriptreact"
  | "javascript"
  | "javascriptreact"
  | "markdown"
  // C 系
  | "c"
  | "cpp"
  | "csharp"
  | "objective-c"
  // JVM
  | "kotlin"
  | "scala"
  | "groovy"
  // 函数式 / 脚本
  | "python"
  | "ruby"
  | "go"
  | "rust"
  | "php"
  | "lua"
  | "dart"
  | "swift"
  | "r"
  // 前端
  | "vue"
  | "svelte";

const SUPPORTED_LANGUAGE_IDS: Set<string> = new Set([
  "java",
  "typescript",
  "typescriptreact",
  "javascript",
  "javascriptreact",
  "markdown",
  // C 系
  "c",
  "cpp",
  "csharp",
  "objective-c",
  // JVM
  "kotlin",
  "scala",
  "groovy",
  // 函数式 / 脚本
  "python",
  "ruby",
  "go",
  "rust",
  "php",
  "lua",
  "dart",
  "swift",
  "r",
  // 前端
  "vue",
  "svelte",
]);

export function isSupportedLanguage(
  languageId: string,
): languageId is SupportedLanguageId {
  return SUPPORTED_LANGUAGE_IDS.has(languageId as SupportedLanguageId);
}
