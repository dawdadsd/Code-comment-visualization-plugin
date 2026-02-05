/**
 * types.ts : 定义类型文件集中管理
 * @authro xiaowu
 * @since 2026/02/
 */

import { SrvRecord } from "dns";
import { DocumentSymbol } from "vscode";

/**
 * brand Types
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
 * example javadoc
 * @param id user unique id
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
 * @throws tag data
 */
export interface ThrowsTag {
  readonly type: string;
  readonly description: string;
}

/**
 * tag tables
 */
export interface TagTable {
  readonly params: readonly ParamTag[];
  readonly returns: ReturnTag | null;
  readonly throws: readonly ThrowsTag[];
  readonly since: string | null;
  readonly author: string | null;
  readonly deprecated: string | null;
  readonly see: readonly string[];
}
/**
 * nul tag tables : method no javadoc use this
 */
export const EMPTY_TAG_TABLE: TagTable = {
  params: [],
  returns: null,
  throws: [],
  since: null,
  author: null,
  deprecated: null,
  see: [],
} as const satisfies TagTable;

/**
 * Git 作者信息
 */
export interface GitAuthorInfo {
  readonly author: string; // 原始作者
  readonly lastModifier: string; // 最后修改者
  readonly lastModifyDate: string; // 最后修改时间
}

/**
 * 方法文档 - 单个方法的完整信息
 */
export interface MethodDoc {
  readonly id: MethodId; // 唯一标识，格式："方法名_行号"
  readonly name: string; // 方法名
  readonly signature: string; // 完整签名，如 "public User findById(Long id)"
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
 * 类文档 - 整个 Java 文件的解析结果
 */
export interface ClassDoc {
  readonly className: string; // 类名
  readonly classComment: string; // 类注释
  readonly packageName: string; // 包名
  readonly filePath: FilePath; // 文件路径
  readonly methods: readonly MethodDoc[]; // 方法列表（扁平化，含内部类）
  readonly gitInfo?: GitAuthorInfo | undefined; // 类的 Git 作者信息（可选）
  readonly javadocAuthor?: string | undefined; // Javadoc @author 标签
  readonly javadocSince?: string | undefined; // Javadoc @since 标签
  readonly fields: readonly FieldDoc[];
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
  | { readonly type: "clearView" };

/**
 * File/Content Document - Column full message
 */
export interface FieldDoc {
  readonly name: string;
  readonly type: string;
  readonly signature: string;
  readonly startLine: LineNumber;
  readonly hasComment: boolean;
  readonly description: string;
  readonly isConstant: boolean;
  readonly accessModifier: AccessModifier;
  readonly belongsTo: string;
}
/**
 * Webview → Extension 的上行消息
 */
export type UpstreamMessage =
  | { readonly type: "jumpToLine"; readonly payload: { line: LineNumber } } // 跳转到某行
  | { readonly type: "webviewReady" }; // Webview 加载完成

/**
 * 类型守卫 - 运行时检查消息是否合法
 *
 *@implNote : 为什么我们需要 类型守卫？
              postMessage 传来的数据是 unknown 类型（可能是任何东西）
 *            我们需要在运行时验证它确实是 UpstreamMessage
              is -> tell TypeScript if true ,value is UpstreamMessage
 */
export function isUpstreamMessage(value: unknown): value is UpstreamMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  // tell TypeScript value is Record<string,unknown>
  const msg = value as Record<string, unknown>;
  switch (msg["type"]) {
    case "jumpToLine":
      // jumpToLine 需要有 payload.line 且是数字
      return (
        typeof msg["payload"] === "object" &&
        msg["payload"] !== null &&
        typeof (msg["payload"] as Record<string, unknown>)["line"] === "number"
      );

    case "webviewReady":
      return true;

    default:
      return false;
  }
}

/**
 * 扩展配置
 */
export interface ExtensionConfig {
  readonly enableAutoHighlight: boolean; // 是否启用反向联动
  readonly debounceDelay: number; // 防抖延迟（毫秒）
  readonly maxMethods: number; // 最大方法数
}

/**
 * 默认配置
 */
export const DEFAULT_CONFIG: ExtensionConfig = {
  enableAutoHighlight: true,
  debounceDelay: 300,
  maxMethods: 200,
} as const satisfies ExtensionConfig;
