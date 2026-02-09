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
type Brand<T, B> = T & {
    readonly [_brand]: B;
};
export type LineNumber = Brand<number, "LineNumber">;
/**
 * Method unique identity type
 */
export type MethodId = Brand<string, "MethodId">;
/**
 * FilePath type
 */
export type FilePath = Brand<string, "FilePath">;
export declare const LineNumber: (n: number) => LineNumber;
export declare const MethodId: (id: string) => MethodId;
export declare const FilePath: (path: string) => FilePath;
export declare const ACCESS_MODIFIERS: readonly ["public", "protected", "private", "default"];
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
export declare const EMPTY_TAG_TABLE: TagTable;
/**
 * Git 作者信息
 */
export interface GitAuthorInfo {
    readonly author: string;
    readonly lastModifier: string;
    readonly lastModifyDate: string;
}
/**
 * 方法类别 —— 区分普通方法和构造函数
 *
 * 【为什么需要区分？】
 * VS Code SymbolKind 中 Method(6) 和 Constructor(9) 是不同的值，
 * 侧边栏需要用不同图标和分组来展示它们
 */
export type MethodKind = "method" | "constructor";
/**
 * 方法文档 - 单个方法的完整信息
 */
export interface MethodDoc {
    readonly id: MethodId;
    readonly kind: MethodKind;
    readonly name: string;
    readonly signature: string;
    readonly startLine: LineNumber;
    readonly endLine: LineNumber;
    readonly hasComment: boolean;
    readonly description: string;
    readonly tags: TagTable;
    readonly belongsTo: string;
    readonly accessModifier: AccessModifier;
    readonly gitInfo?: GitAuthorInfo | undefined;
}
/**
 * 类文档 - 整个 Java 文件的解析结果
 */
export interface ClassDoc {
    readonly className: string;
    readonly classComment: string;
    readonly packageName: string;
    readonly filePath: FilePath;
    readonly methods: readonly MethodDoc[];
    readonly fields: readonly FieldDoc[];
    readonly enumConstants: readonly EnumConstantDoc[];
    readonly gitInfo?: GitAuthorInfo | undefined;
    readonly javadocAuthor?: string | undefined;
    readonly javadocSince?: string | undefined;
}
/**
 * Extension → Webview 的下行消息
 * updateView : 刷新整个视图
 * highlightMethod : 高亮某个方法
 * clearView : 清空视图
 */
export type DownstreamMessage = {
    readonly type: "updateView";
    readonly payload: ClassDoc;
} | {
    readonly type: "highlightMethod";
    readonly payload: {
        id: MethodId;
    };
} | {
    readonly type: "clearView";
};
/**
 * 字段文档 - 普通字段和常量的信息
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
 * 枚举常量文档 - 独立于 FieldDoc 的类型
 *
 * 【为什么不复用 FieldDoc？】
 * 枚举常量的语法与普通字段完全不同：
 *   - 没有类型声明（类型就是枚举自身）
 *   - 没有访问修饰符（隐式 public static final）
 *   - 可以有构造参数：SUCCESS(200, "OK")
 *   - 用逗号分隔而非分号
 * 强行复用会导致 extractFieldType / extractAccessModifier 产生错误结果
 */
export interface EnumConstantDoc {
    readonly name: string;
    readonly startLine: LineNumber;
    readonly hasComment: boolean;
    readonly description: string;
    readonly arguments: string;
    readonly belongsTo: string;
}
/**
 * Webview → Extension 的上行消息
 */
export type UpstreamMessage = {
    readonly type: "jumpToLine";
    readonly payload: {
        line: LineNumber;
    };
} | {
    readonly type: "webviewReady";
};
/**
 * 类型守卫 - 运行时检查消息是否合法
 *
 *@implNote : 为什么我们需要 类型守卫？
              postMessage 传来的数据是 unknown 类型（可能是任何东西）
 *            我们需要在运行时验证它确实是 UpstreamMessage
              is -> tell TypeScript if true ,value is UpstreamMessage
 */
export declare function isUpstreamMessage(value: unknown): value is UpstreamMessage;
/**
 * 扩展配置
 */
export interface ExtensionConfig {
    readonly enableAutoHighlight: boolean;
    readonly debounceDelay: number;
    readonly maxMethods: number;
}
/**
 * 默认配置
 */
export declare const DEFAULT_CONFIG: ExtensionConfig;
export type SupportedLanguageId = "java" | "typescript" | "javascript";
export declare function isSupportedLanguage(languageId: string): languageId is SupportedLanguageId;
export {};
