"use strict";
/**
 * JavaDocParser.ts - Javadoc 主解析器
 *
 * 【职责】
 * 1. 调用 SymbolResolver 获取代码结构
 * 2. 从源代码中提取 Javadoc 注释
 * 3. 调用 TagParser 解析标签
 * 4. 组装成 ClassDoc 数据结构
 * 5. 获取 Git 作者信息
 *
 * 【解析流程】
 * TextDocument → Symbol树 → 扁平化符号列表 → 按类别分别解析 → ClassDoc
 *
 * 【符号分类】
 * Symbol 树中的符号被分为四类：
 *   Container（类/接口/枚举）→ 递归展开子符号
 *   Method / Constructor     → parseMethod（通过 kind 字段区分）
 *   Field / Constant         → parseField
 *   EnumMember               → parseEnumConstant（独立解析路径）
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
exports.JavaDocParser = void 0;
const path = __importStar(require("path"));
const SymbolResolver_js_1 = require("./SymbolResolver.js");
const TagParser_js_1 = require("./TagParser.js");
const GitService_js_1 = require("../services/GitService.js");
const types_js_1 = require("../types.js");
// ========== 解析器 ==========
/**
 * Javadoc 解析器
 */
class JavaDocParser {
    // 匹配 Javadoc 注释块 /** ... */
    javadocPattern = /\/\*\*[\s\S]*?\*\//;
    // 匹配 Java 注解 @Override, @Transactional 等
    annotationPattern = /^\s*@[\w.]+/;
    // 顶层类型声明（class/interface/enum/record/@interface）匹配
    topLevelTypePattern = /^\s*(?:@[\w.]+(?:\([^)]*\))?\s+)*(?:(?:public|protected|private|abstract|final|static|sealed|non-sealed|strictfp)\s+)*(?:class|interface|enum|record|@interface)\s+([A-Za-z_$][\w$]*)\b/;
    /**
     * 解析 Java 文档
     *
     * @param document - VS Code 的文档对象
     * @returns 解析后的类文档结构
     */
    async parse(document) {
        const symbols = await (0, SymbolResolver_js_1.resolveSymbols)(document.uri);
        const text = document.getText();
        const filePath = document.uri.fsPath;
        // 步骤 2：提取类信息
        const classSymbol = this.findClassSymbol(symbols, filePath);
        const fallbackClassInfo = classSymbol
            ? null
            : this.extractPrimaryTypeInfoFromText(text, filePath);
        const className = classSymbol?.name ??
            fallbackClassInfo?.className ??
            this.extractClassNameFromText(text);
        const packageName = this.extractPackageName(text);
        const classLine = classSymbol?.selectionRange?.start.line ??
            classSymbol?.range.start.line ??
            fallbackClassInfo?.classLine ??
            0;
        // 提取类注释
        const classComment = (classSymbol ? this.extractComment(text, classLine) : "") ||
            fallbackClassInfo?.classComment ||
            "";
        const { author: javadocAuthor, since: javadocSince } = this.parseClassJavadoc(classComment);
        // ---- 扁平化 Symbol 树 ----
        const flattenedSymbols = this.flattenSymbols(symbols, "");
        // ---- 按类别分别解析 ----
        // 传入 classComment 用于排除 Lombok 等工具生成的符号误关联类注释的情况
        // 例如 @Slf4j 生成的 log 字段，Language Server 将其位置报告在类声明附近，
        // extractComment 向上搜索会错误地找到类 Javadoc
        const methods = flattenedSymbols
            .filter((fs) => (0, SymbolResolver_js_1.isMethodSymbol)(fs.symbol))
            .map((fs) => this.parseMethod(text, fs, classComment))
            .filter((m) => m !== null)
            .sort((a, b) => a.startLine - b.startLine);
        const fields = flattenedSymbols
            .filter((fs) => (0, SymbolResolver_js_1.isFieldSymbol)(fs.symbol))
            .map((fs) => this.parseField(text, fs, classComment))
            .filter((f) => f !== null)
            .sort((a, b) => a.startLine - b.startLine);
        const enumConstants = flattenedSymbols
            .filter((fs) => (0, SymbolResolver_js_1.isEnumMemberSymbol)(fs.symbol))
            .map((fs) => this.parseEnumConstant(text, fs, classComment))
            .filter((e) => e !== null)
            .sort((a, b) => a.startLine - b.startLine);
        // ---- Git 信息（异步，不阻塞主流程） ----
        const gitInfo = await this.getGitInfo(filePath, classLine);
        return {
            className,
            classComment: this.cleanComment(classComment),
            packageName,
            filePath: (0, types_js_1.FilePath)(filePath),
            methods,
            fields,
            enumConstants,
            gitInfo,
            javadocAuthor,
            javadocSince,
        };
    }
    // ========== Symbol 树处理 ==========
    /**
     * 递归扁平化 Symbol 树
     *
     * 遇到容器（类/接口/枚举）→ 递归处理其子符号，记录完整类名
     * 遇到方法/字段/枚举常量     → 收集到结果中
     */
    flattenSymbols(symbols, parentName) {
        const result = [];
        for (const symbol of symbols) {
            if ((0, SymbolResolver_js_1.isClassLikeSymbol)(symbol)) {
                const currentClass = parentName
                    ? `${parentName}.${symbol.name}`
                    : symbol.name;
                if (symbol.children.length > 0) {
                    result.push(...this.flattenSymbols(symbol.children, currentClass));
                }
            }
            else if ((0, SymbolResolver_js_1.isMethodSymbol)(symbol) ||
                (0, SymbolResolver_js_1.isFieldSymbol)(symbol) ||
                (0, SymbolResolver_js_1.isEnumMemberSymbol)(symbol)) {
                result.push({
                    symbol,
                    belongsTo: parentName || "Unknown",
                });
            }
        }
        return result;
    }
    // ========== 方法解析 ==========
    /**
     * 解析单个方法（包括构造函数）
     *
     * 构造函数与普通方法走同一解析路径，
     * 仅在最终赋值 kind 时通过 isConstructorSymbol 区分
     */
    parseMethod(text, flattened, classComment) {
        try {
            const { symbol, belongsTo } = flattened;
            const lines = text.split("\n");
            const startLine = (0, types_js_1.LineNumber)(symbol.selectionRange?.start.line ?? symbol.range.start.line);
            const endLine = (0, types_js_1.LineNumber)(symbol.range.end.line);
            const fullSignature = this.extractFullSignature(lines, startLine);
            const rawComment = this.extractMemberComment(text, startLine, classComment);
            const hasComment = rawComment.length > 0;
            const { description, tags } = hasComment
                ? this.parseJavadoc(rawComment, fullSignature)
                : { description: "", tags: types_js_1.EMPTY_TAG_TABLE };
            const accessModifier = this.extractAccessModifierFromLine(fullSignature);
            const kind = (0, SymbolResolver_js_1.isConstructorSymbol)(symbol)
                ? "constructor"
                : "method";
            const displaySignature = symbol.detail || this.extractSignatureFromLine(lines[startLine] ?? "");
            return {
                id: (0, types_js_1.MethodId)(`${symbol.name}_${startLine}`),
                kind,
                name: symbol.name,
                signature: displaySignature,
                startLine,
                endLine,
                hasComment,
                description,
                tags,
                belongsTo,
                accessModifier,
            };
        }
        catch (error) {
            console.error(`[JavaDocParser] Failed to parse method: ${flattened.symbol.name}`, error);
            return null;
        }
    }
    // ========== 字段解析 ==========
    /**
     * 解析单个字段（普通字段 / static final 常量）
     */
    parseField(text, flattened, classComment) {
        try {
            const { symbol, belongsTo } = flattened;
            const lines = text.split("\n");
            const startLine = (0, types_js_1.LineNumber)(symbol.selectionRange?.start.line ?? symbol.range.start.line);
            const lineText = lines[startLine]?.trim() ?? "";
            const rawComment = this.extractMemberComment(text, startLine, classComment);
            const hasComment = rawComment.length > 0;
            const description = hasComment ? this.cleanComment(rawComment) : "";
            const isConstant = lineText.includes("static") && lineText.includes("final");
            const accessModifier = this.extractAccessModifierFromLine(lineText);
            const fieldType = symbol.detail || this.extractFieldType(lineText);
            return {
                name: symbol.name,
                type: fieldType,
                signature: lineText,
                startLine,
                hasComment,
                description,
                isConstant,
                accessModifier,
                belongsTo,
            };
        }
        catch (error) {
            console.error(`[JavaDocParser] Failed to parse field: ${flattened.symbol.name}`, error);
            return null;
        }
    }
    // ========== 枚举常量解析 ==========
    /**
     * 解析单个枚举常量
     *
     * 枚举常量的语法与普通字段完全不同：
     *   SUCCESS(200, "OK"),       ← 有构造参数
     *   PENDING,                  ← 无构造参数
     *   UNKNOWN;                  ← 最后一个用分号
     *
     * 因此不复用 parseField，而是独立解析
     */
    parseEnumConstant(text, flattened, classComment) {
        try {
            const { symbol, belongsTo } = flattened;
            const lines = text.split("\n");
            const startLine = (0, types_js_1.LineNumber)(symbol.selectionRange?.start.line ?? symbol.range.start.line);
            const lineText = lines[startLine]?.trim() ?? "";
            const rawComment = this.extractMemberComment(text, startLine, classComment);
            const hasComment = rawComment.length > 0;
            const description = hasComment ? this.cleanComment(rawComment) : "";
            const args = this.extractEnumArguments(lineText);
            return {
                name: symbol.name,
                startLine,
                hasComment,
                description,
                arguments: args,
                belongsTo,
            };
        }
        catch (error) {
            console.error(`[JavaDocParser] Failed to parse enum constant: ${flattened.symbol.name}`, error);
            return null;
        }
    }
    /**
     * 提取枚举常量的构造参数
     *
     * 使用括号深度匹配，正确处理嵌套括号
     *
     * @example
     *   "SUCCESS(200, \"OK\")" → "(200, \"OK\")"
     *   "PENDING,"             → ""
     *   "UNKNOWN;"             → ""
     */
    extractEnumArguments(lineText) {
        const openIndex = lineText.indexOf("(");
        if (openIndex === -1)
            return "";
        let depth = 0;
        for (let i = openIndex; i < lineText.length; i++) {
            const ch = lineText[i];
            if (ch === "(")
                depth++;
            else if (ch === ")") {
                depth--;
                if (depth === 0) {
                    return lineText.slice(openIndex, i + 1);
                }
            }
        }
        // 括号未闭合，返回从 ( 到行尾（去掉末尾的逗号/分号）
        return lineText.slice(openIndex).replace(/[,;]\s*$/, "");
    }
    // ========== Javadoc 注释提取与解析 ==========
    /**
     * 提取成员的 Javadoc 注释（带类注释去重保护）
     *
     * 【为什么需要这个方法？】
     * Lombok 等注解处理器会生成虚拟符号（如 @Slf4j → log 字段），
     * Language Server 将这些符号的位置报告在类声明附近。
     * extractComment 向上搜索时会错误地找到类 Javadoc。
     *
     * 此方法在 extractComment 的基础上增加一层校验：
     * 如果提取到的注释与类注释完全相同，说明是误关联，返回空字符串。
     */
    extractMemberComment(text, targetLine, classComment) {
        const raw = this.extractComment(text, targetLine);
        if (raw.length === 0)
            return "";
        // 如果与类注释相同，说明是 Lombok 生成符号的误关联
        if (classComment.length > 0 && raw === classComment)
            return "";
        return raw;
    }
    /**
     * 解析 Javadoc 注释内容
     */
    parseJavadoc(rawComment, signature) {
        const cleaned = this.cleanComment(rawComment);
        const tagIndex = cleaned.search(/@\w+/);
        const description = tagIndex === -1 ? cleaned : cleaned.slice(0, tagIndex).trim();
        const rawTags = tagIndex === -1 ? "" : cleaned.slice(tagIndex);
        const tags = (0, TagParser_js_1.parseTagTable)(rawTags, signature);
        return { description, tags };
    }
    /**
     * 解析类注释中的 @author 和 @since
     */
    parseClassJavadoc(comment) {
        const authorMatch = /@author\s+(.+?)(?:\n|$)/.exec(comment);
        const sinceMatch = /@since\s+(.+?)(?:\n|$)/.exec(comment);
        return {
            author: authorMatch?.[1]?.trim(),
            since: sinceMatch?.[1]?.trim(),
        };
    }
    /**
     * 清理 Javadoc 注释格式
     */
    cleanComment(raw) {
        return raw
            .replace(/\r\n/g, "\n")
            .replace(/\/\*\*|\*\//g, "")
            .split("\n")
            .map((line) => line.replace(/^\s*\*\s?/, ""))
            .join("\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    }
    /**
     * 提取完整的方法签名（处理跨行声明）
     *
     * Spring Controller 方法带多个注解参数时，签名可能跨越 8-10 行，例如：
     *   public ResponseEntity<User> updateUser(
     *       @PathVariable Long id,
     *       @RequestBody @Valid UserUpdateDTO dto,
     *       @RequestParam(required = false) String reason,
     *       @AuthenticationPrincipal UserDetails principal
     *   ) {
     *
     * 上限设为 15 行，覆盖绝大多数实际方法签名
     */
    static MAX_SIGNATURE_LINES = 15;
    extractFullSignature(lines, startLine) {
        let signature = "";
        let lineIndex = startLine;
        let parenDepth = 0;
        let foundOpenParen = false;
        const maxLine = Math.min(lines.length, startLine + JavaDocParser.MAX_SIGNATURE_LINES);
        while (lineIndex < maxLine) {
            const line = lines[lineIndex] ?? "";
            for (const char of line) {
                signature += char;
                if (char === "(") {
                    foundOpenParen = true;
                    parenDepth++;
                }
                else if (char === ")") {
                    parenDepth--;
                    if (foundOpenParen && parenDepth === 0) {
                        return signature.replace(/\s+/g, " ").trim();
                    }
                }
            }
            signature += " ";
            lineIndex++;
        }
        return signature.replace(/\s+/g, " ").trim();
    }
    /**
     * 提取目标行上方最近的 Javadoc 注释块
     */
    extractComment(text, targetLine) {
        const lines = text.split("\n");
        // 从目标行向上找最近的 "*/"，并要求注释后到目标行之间仅包含空行或注解块。
        for (let endLine = targetLine - 1; endLine >= 0; endLine--) {
            const trimmed = lines[endLine]?.trim() ?? "";
            if (trimmed === "")
                continue;
            if (!trimmed.endsWith("*/"))
                continue;
            const between = lines.slice(endLine + 1, targetLine);
            if (!this.onlyBlankOrAnnotations(between))
                continue;
            // 从 endLine 向上找对应的 "/**"
            for (let startLine = endLine; startLine >= 0; startLine--) {
                const line = lines[startLine] ?? "";
                if (line.includes("/**")) {
                    return lines.slice(startLine, endLine + 1).join("\n");
                }
                // 遇到另一个块注释结束，说明不在同一个注释块内了
                if (startLine !== endLine && line.includes("*/"))
                    break;
            }
        }
        return "";
    }
    /**
     * 判断一段代码是否仅由空行或注解（含多行注解参数）构成
     */
    onlyBlankOrAnnotations(lines) {
        let i = 0;
        while (i < lines.length) {
            const line = lines[i]?.trim() ?? "";
            if (line === "") {
                i++;
                continue;
            }
            if (!this.annotationPattern.test(line)) {
                return false;
            }
            // 处理多行注解：@Anno( ... ) 可能跨多行
            const openParens = lines[i]?.match(/\(/g)?.length ?? 0;
            const closeParens = lines[i]?.match(/\)/g)?.length ?? 0;
            let parenDepth = openParens - closeParens;
            i++;
            while (i < lines.length && parenDepth > 0) {
                const next = lines[i] ?? "";
                const nextOpen = next.match(/\(/g)?.length ?? 0;
                const nextClose = next.match(/\)/g)?.length ?? 0;
                parenDepth += nextOpen - nextClose;
                i++;
            }
        }
        return true;
    }
    // ========== 辅助方法 ==========
    extractAccessModifierFromLine(line) {
        if (line.includes("public "))
            return "public";
        if (line.includes("protected "))
            return "protected";
        if (line.includes("private "))
            return "private";
        return "default";
    }
    /**
     * 从代码行中提取方法签名
     */
    extractSignatureFromLine(line) {
        // 移除方法体部分（如果在同一行）
        const withoutBody = line.replace(/\{.*$/, "").trim();
        return withoutBody || line;
    }
    /**
     * 从 Symbol 列表中找到类符号
     */
    findClassSymbol(symbols, filePath) {
        const classLikes = symbols.filter((s) => (0, SymbolResolver_js_1.isClassLikeSymbol)(s));
        if (classLikes.length === 0)
            return undefined;
        const baseName = path.basename(filePath, path.extname(filePath));
        const matched = classLikes.find((s) => s.name === baseName);
        return matched ?? classLikes[0];
    }
    /**
     * 从文本中提取类名（Symbol 解析失败时的降级方案）
     */
    extractClassNameFromText(text) {
        const match = /(?:class|interface|enum)\s+(\w+)/.exec(text);
        return match?.[1] ?? "Unknown";
    }
    /**
     * 当符号解析失败时，从源码文本中提取“主类型”(top-level)信息
     *
     * - 只识别 braceDepth===0 的类型声明，避免误选内部类
     * - 优先选择与文件名同名的类型（常见 Java 约定）
     */
    extractPrimaryTypeInfoFromText(text, filePath) {
        const lines = text.split("\n");
        const baseName = path.basename(filePath, path.extname(filePath));
        let braceDepth = 0;
        let state = {
            inBlockComment: false,
            inString: false,
            inChar: false,
        };
        let first = null;
        let preferred = null;
        for (let i = 0; i < lines.length; i++) {
            const rawLine = lines[i] ?? "";
            const parsed = this.parseLineForStructure(rawLine, state);
            state = parsed.state;
            if (braceDepth === 0) {
                const match = this.topLevelTypePattern.exec(parsed.code);
                if (match?.[1]) {
                    const name = match[1];
                    const line = i;
                    first ??= { name, line };
                    if (name === baseName) {
                        preferred = { name, line };
                        break;
                    }
                }
            }
            braceDepth += parsed.openBraces - parsed.closeBraces;
        }
        const chosen = preferred ?? first;
        const className = chosen?.name ?? "Unknown";
        const classLine = chosen?.line ?? 0;
        const classComment = this.extractComment(text, classLine);
        return { className, classLine, classComment };
    }
    /**
     * 用于顶层扫描时剔除注释/字符串，避免 braceDepth 计算误差
     */
    parseLineForStructure(line, state) {
        let code = "";
        let openBraces = 0;
        let closeBraces = 0;
        let inBlockComment = state.inBlockComment;
        let inString = state.inString;
        let inChar = state.inChar;
        let escaped = false;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i] ?? "";
            const next = line[i + 1] ?? "";
            if (inBlockComment) {
                if (ch === "*" && next === "/") {
                    inBlockComment = false;
                    i++;
                }
                continue;
            }
            if (inString) {
                if (escaped) {
                    escaped = false;
                    continue;
                }
                if (ch === "\\") {
                    escaped = true;
                    continue;
                }
                if (ch === '"') {
                    inString = false;
                }
                continue;
            }
            if (inChar) {
                if (escaped) {
                    escaped = false;
                    continue;
                }
                if (ch === "\\") {
                    escaped = true;
                    continue;
                }
                if (ch === "'") {
                    inChar = false;
                }
                continue;
            }
            // 行注释：忽略剩余内容
            if (ch === "/" && next === "/") {
                break;
            }
            // 块注释开始
            if (ch === "/" && next === "*") {
                inBlockComment = true;
                i++;
                continue;
            }
            if (ch === '"') {
                inString = true;
                continue;
            }
            if (ch === "'") {
                inChar = true;
                continue;
            }
            if (ch === "{")
                openBraces++;
            if (ch === "}")
                closeBraces++;
            code += ch;
        }
        return {
            code,
            openBraces,
            closeBraces,
            state: { inBlockComment, inString, inChar },
        };
    }
    /**
     * 从字段声明行提取类型
     * 例如: "private static final int MAX_SIZE = 100;" → "int"
     */
    extractFieldType(line) {
        const withoutAssign = line.split("=")[0] ?? "";
        const withoutSemicolon = withoutAssign.replace(/;$/, "").trim();
        const parts = withoutSemicolon.split(/\s+/);
        if (parts.length >= 2) {
            return parts[parts.length - 2] ?? "unknown";
        }
        return "unknown";
    }
    extractPackageName(text) {
        const match = /package\s+([\w.]+);/.exec(text);
        return match?.[1] ?? "";
    }
    // ========== Git 集成 ==========
    async getGitInfo(filePath, classLine) {
        try {
            const isGitRepo = await GitService_js_1.gitService.isGitRepository(filePath);
            if (!isGitRepo)
                return undefined;
            const info = await GitService_js_1.gitService.getClassGitInfo(filePath, classLine);
            if (!info)
                return undefined;
            return {
                author: info.author,
                lastModifier: info.lastModifier,
                lastModifyDate: info.lastModifyDate,
            };
        }
        catch {
            return undefined;
        }
    }
}
exports.JavaDocParser = JavaDocParser;
//# sourceMappingURL=JavaDocParser.js.map