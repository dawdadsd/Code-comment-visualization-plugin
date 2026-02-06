/**
 * SymbolResolver.ts - 符号解析器
 *
 * 通过 VS Code 的 Document Symbol Provider 获取 Java 符号，
 * 并提供统一的分类判断函数供解析器复用。
 * vscode的document.version是递增函数,可以用来做简单的缓存.
 */

import * as vscode from "vscode";
import type { DocumentSymbol, Uri } from "vscode";

const EXECUTE_DOCUMENT_SYMBOL_PROVIDER = "vscode.executeDocumentSymbolProvider";

const CLASS_LIKE_KINDS: ReadonlySet<vscode.SymbolKind> = new Set([
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Interface,
  vscode.SymbolKind.Enum,
]);

const METHOD_KINDS: ReadonlySet<vscode.SymbolKind> = new Set([
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Constructor,
]);

const FIELD_KINDS: ReadonlySet<vscode.SymbolKind> = new Set([
  vscode.SymbolKind.Field,
  vscode.SymbolKind.Constant,
]);

interface CachedSymbols {
  readonly version: number;
  readonly symbols: DocumentSymbol[];
}

// 缓存同一文档版本的符号，避免面板/侧栏重复刷新时重复请求语言服务。
const symbolCache = new Map<string, CachedSymbols>();

/**
 * delete the symbol cache (document closed)
 * @param uri
 */
export function clearSymbolCache(uri: Uri): void {
  symbolCache.delete(uri.toString());
}

/**
 * extension closed, clear all cache
 */
export function clearAllSymbolCache(): void {
  symbolCache.clear();
}

/**
 * 获取文档中的符号列表。
 *
 * - 命中缓存：O(1) 直接返回
 * - 未命中：调用 `vscode.executeDocumentSymbolProvider`
 */
export async function resolveSymbols(uri: Uri): Promise<DocumentSymbol[]> {
  const cacheKey = uri.toString();
  const version = getOpenDocumentVersion(uri);

  if (version !== undefined) {
    const cached = symbolCache.get(cacheKey);
    if (cached?.version === version) {
      return cached.symbols;
    }
  }
  try {
    const raw = await vscode.commands.executeCommand<unknown>(
      EXECUTE_DOCUMENT_SYMBOL_PROVIDER,
      uri,
    );
    const symbols = normalizeDocumentSymbols(raw);
    if (version !== undefined) {
      symbolCache.set(cacheKey, { version, symbols });
    }
    return symbols;
  } catch (error) {
    console.error("[SymbolResolver] Failed to resolve symbols:", error);
    return [];
  }
}

/**
 * 容器符号：Class / Interface / Enum
 */
export function isClassLikeSymbol(symbol: DocumentSymbol): boolean {
  return CLASS_LIKE_KINDS.has(symbol.kind);
}

/**
 * 可调用成员：Method / Constructor
 */
export function isMethodSymbol(symbol: DocumentSymbol): boolean {
  return METHOD_KINDS.has(symbol.kind);
}

/**
 * 数据成员：Field / Constant（不含 EnumMember）
 */
export function isFieldSymbol(symbol: DocumentSymbol): boolean {
  return FIELD_KINDS.has(symbol.kind);
}

/**
 * 枚举常量：EnumMember
 */
export function isEnumMemberSymbol(symbol: DocumentSymbol): boolean {
  return symbol.kind === vscode.SymbolKind.EnumMember;
}

/**
 * 构造函数：Constructor
 */
export function isConstructorSymbol(symbol: DocumentSymbol): boolean {
  return symbol.kind === vscode.SymbolKind.Constructor;
}

/**
 * 遍历工作区中打开的文档，获取对应 URI 的文档版本号。
 *
 * @param uri 目标文档 URI
 * @returns 文档版本号，若文档未打开则返回 undefined
 */
function getOpenDocumentVersion(uri: Uri): number | undefined {
  const target = uri.toString();
  for (const document of vscode.workspace.textDocuments) {
    if (document.uri.toString() === target) {
      return document.version;
    }
  }
  return undefined;
}

/**
 * 规范化 DocumentSymbol 数组，确保类型安全。
 *
 * @param result 未知类型的符号结果
 * @returns 规范化后的 DocumentSymbol 数组，若不符合预期则返回空数组
 */
function normalizeDocumentSymbols(result: unknown): DocumentSymbol[] {
  if (!Array.isArray(result) || result.length === 0) {
    return [];
  }
  const first = result[0];
  if (!isDocumentSymbol(first)) {
    return [];
  }
  return result as DocumentSymbol[];
}

/**
 * 判断一个值是否为 DocumentSymbol 类型。
 * @param value 待检查的值
 * @returns 如果值是 DocumentSymbol 类型则返回 true，否则返回 false
 */
function isDocumentSymbol(value: unknown): value is DocumentSymbol {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const symbol = value as Partial<DocumentSymbol>;
  return typeof symbol.kind === "number" && Array.isArray(symbol.children);
}
