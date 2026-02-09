/**
 * SymbolResolver.ts - 符号解析器
 *
 * 通过 VS Code 的 Document Symbol Provider 获取 Java 符号，
 * 并提供统一的分类判断函数供解析器复用。
 * vscode的document.version是递增函数,可以用来做简单的缓存.
 */
import type { DocumentSymbol, Uri } from "vscode";
/**
 * delete the symbol cache (document closed)
 * @param uri
 */
export declare function clearSymbolCache(uri: Uri): void;
/**
 * extension closed, clear all cache
 */
export declare function clearAllSymbolCache(): void;
/**
 * 获取文档中的符号列表。
 *
 * - 命中缓存：O(1) 直接返回
 * - 未命中：调用 `vscode.executeDocumentSymbolProvider`
 */
export declare function resolveSymbols(uri: Uri): Promise<DocumentSymbol[]>;
/**
 * 容器符号：Class / Interface / Enum
 */
export declare function isClassLikeSymbol(symbol: DocumentSymbol): boolean;
/**
 * 可调用成员：Method / Constructor
 */
export declare function isMethodSymbol(symbol: DocumentSymbol): boolean;
/**
 * 数据成员：Field / Constant（不含 EnumMember）
 */
export declare function isFieldSymbol(symbol: DocumentSymbol): boolean;
/**
 * 枚举常量：EnumMember
 */
export declare function isEnumMemberSymbol(symbol: DocumentSymbol): boolean;
/**
 * 构造函数：Constructor
 */
export declare function isConstructorSymbol(symbol: DocumentSymbol): boolean;
