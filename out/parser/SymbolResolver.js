"use strict";
/**
 * SymbolResolver.ts - 符号解析器
 *
 * 通过 VS Code 的 Document Symbol Provider 获取 Java 符号，
 * 并提供统一的分类判断函数供解析器复用。
 * vscode的document.version是递增函数,可以用来做简单的缓存.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.clearSymbolCache = clearSymbolCache;
exports.clearAllSymbolCache = clearAllSymbolCache;
exports.resolveSymbols = resolveSymbols;
exports.isClassLikeSymbol = isClassLikeSymbol;
exports.isMethodSymbol = isMethodSymbol;
exports.isFieldSymbol = isFieldSymbol;
exports.isEnumMemberSymbol = isEnumMemberSymbol;
exports.isConstructorSymbol = isConstructorSymbol;
const vscode = __importStar(require("vscode"));
const EXECUTE_DOCUMENT_SYMBOL_PROVIDER = "vscode.executeDocumentSymbolProvider";
const CLASS_LIKE_KINDS = new Set([
    vscode.SymbolKind.Class,
    vscode.SymbolKind.Interface,
    vscode.SymbolKind.Enum,
]);
const METHOD_KINDS = new Set([
    vscode.SymbolKind.Method,
    vscode.SymbolKind.Constructor,
    vscode.SymbolKind.Function
]);
const FIELD_KINDS = new Set([
    vscode.SymbolKind.Field,
    vscode.SymbolKind.Constant,
]);
// 缓存同一文档版本的符号，避免面板/侧栏重复刷新时重复请求语言服务。
const symbolCache = new Map();
/**
 * delete the symbol cache (document closed)
 * @param uri
 */
function clearSymbolCache(uri) {
    symbolCache.delete(uri.toString());
}
/**
 * extension closed, clear all cache
 */
function clearAllSymbolCache() {
    symbolCache.clear();
}
/**
 * 获取文档中的符号列表。
 *
 * - 命中缓存：O(1) 直接返回
 * - 未命中：调用 `vscode.executeDocumentSymbolProvider`
 */
async function resolveSymbols(uri) {
    const cacheKey = uri.toString();
    const version = getOpenDocumentVersion(uri);
    if (version !== undefined) {
        const cached = symbolCache.get(cacheKey);
        if (cached?.version === version) {
            return cached.symbols;
        }
    }
    try {
        const raw = await vscode.commands.executeCommand(EXECUTE_DOCUMENT_SYMBOL_PROVIDER, uri);
        const symbols = normalizeDocumentSymbols(raw);
        if (version !== undefined) {
            symbolCache.set(cacheKey, { version, symbols });
        }
        return symbols;
    }
    catch (error) {
        console.error("[SymbolResolver] Failed to resolve symbols:", error);
        return [];
    }
}
/**
 * 容器符号：Class / Interface / Enum
 */
function isClassLikeSymbol(symbol) {
    return CLASS_LIKE_KINDS.has(symbol.kind);
}
/**
 * 可调用成员：Method / Constructor
 */
function isMethodSymbol(symbol) {
    return METHOD_KINDS.has(symbol.kind);
}
/**
 * 数据成员：Field / Constant（不含 EnumMember）
 */
function isFieldSymbol(symbol) {
    return FIELD_KINDS.has(symbol.kind);
}
/**
 * 枚举常量：EnumMember
 */
function isEnumMemberSymbol(symbol) {
    return symbol.kind === vscode.SymbolKind.EnumMember;
}
/**
 * 构造函数：Constructor
 */
function isConstructorSymbol(symbol) {
    return symbol.kind === vscode.SymbolKind.Constructor;
}
/**
 * 遍历工作区中打开的文档，获取对应 URI 的文档版本号。
 *
 * @param uri 目标文档 URI
 * @returns 文档版本号，若文档未打开则返回 undefined
 */
function getOpenDocumentVersion(uri) {
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
function normalizeDocumentSymbols(result) {
    if (!Array.isArray(result) || result.length === 0) {
        return [];
    }
    const first = result[0];
    if (!isDocumentSymbol(first)) {
        return [];
    }
    return result;
}
/**
 * 判断一个值是否为 DocumentSymbol 类型。
 * @param value 待检查的值
 * @returns 如果值是 DocumentSymbol 类型则返回 true，否则返回 false
 */
function isDocumentSymbol(value) {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const symbol = value;
    return typeof symbol.kind === "number" && Array.isArray(symbol.children);
}
//# sourceMappingURL=SymbolResolver.js.map