"use strict";
/**
 * SymbolResolver.ts - 符号解析器
 *
 * 【什么是 DocumentSymbol？】
 * VS Code 的语言服务（如 Java 扩展）会分析代码，提取出"符号"：
 * - 类（Class）、接口（Interface）、枚举（Enum）
 * - 方法（Method）、构造函数（Constructor）
 * - 字段（Field）、常量（Constant）、枚举成员（EnumMember）
 *
 * 每个符号包含：名称、类型（SymbolKind）、在文件中的位置（行号范围）
 *
 * 【为什么用 Symbol API 而不是自己解析？】
 * 1. 准确：语言服务用完整的解析器，能处理各种复杂语法
 * 2. 可靠：泛型、注解、内部类等都能正确识别
 * 3. 省力：不需要自己写 Java 语法解析器
 *
 * 【符号分类策略】
 * 我们将 SymbolKind 归纳为四个语义类别：
 *   Container  — Class / Interface / Enum（可以包含成员的容器）
 *   Method     — Method / Constructor（可调用的成员）
 *   Field      — Field / Constant（数据成员）
 *   EnumMember — EnumMember（枚举常量，语法上完全不同于 Field）
 *
 * 同时提供细粒度判断函数（isConstructorSymbol / isEnumMemberSymbol），
 * 让上层可以在 "归类" 的基础上进一步 "区分"。
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
exports.resolveSymbols = resolveSymbols;
exports.isClassLikeSymbol = isClassLikeSymbol;
exports.isMethodSymbol = isMethodSymbol;
exports.isFieldSymbol = isFieldSymbol;
exports.isEnumMemberSymbol = isEnumMemberSymbol;
exports.isConstructorSymbol = isConstructorSymbol;
const vscode = __importStar(require("vscode"));
/**
 * 获取文档中的所有符号
 *
 * @param uri - 文件的 URI
 * @returns 符号列表，如果解析失败返回空数组
 */
async function resolveSymbols(uri) {
    try {
        const symbols = await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", uri);
        return symbols ?? [];
    }
    catch (error) {
        console.error("[SymbolResolver] Failed to resolve symbols:", error);
        return [];
    }
}
// ========== 类别判断（归类） ==========
/**
 * 容器符号：类 / 接口 / 枚举
 * 这些符号可以包含子符号（方法、字段等）
 */
function isClassLikeSymbol(symbol) {
    return (symbol.kind === vscode.SymbolKind.Class ||
        symbol.kind === vscode.SymbolKind.Interface ||
        symbol.kind === vscode.SymbolKind.Enum);
}
/**
 * 可调用成员：普通方法 / 构造函数
 * 两者在解析流程中走同一条路径（extractComment → parseJavadoc），
 * 但最终通过 isConstructorSymbol 区分 MethodDoc.kind
 */
function isMethodSymbol(symbol) {
    return (symbol.kind === vscode.SymbolKind.Method ||
        symbol.kind === vscode.SymbolKind.Constructor);
}
/**
 * 数据成员：普通字段 / 常量
 * 不包含 EnumMember —— 枚举常量的语法结构完全不同，需要独立处理
 */
function isFieldSymbol(symbol) {
    return (symbol.kind === vscode.SymbolKind.Field ||
        symbol.kind === vscode.SymbolKind.Constant);
}
/**
 * 枚举常量：EnumMember（SymbolKind = 22）
 * 独立于 Field，因为枚举常量没有类型声明、没有显式修饰符、用逗号分隔
 */
function isEnumMemberSymbol(symbol) {
    return symbol.kind === vscode.SymbolKind.EnumMember;
}
// ========== 细粒度判断（区分） ==========
/**
 * 判断是否是构造函数（用于设置 MethodDoc.kind）
 */
function isConstructorSymbol(symbol) {
    return symbol.kind === vscode.SymbolKind.Constructor;
}
//# sourceMappingURL=SymbolResolver.js.map