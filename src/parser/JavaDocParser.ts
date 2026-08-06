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

import type { TextDocument, DocumentSymbol } from "vscode";
import type { Tree } from "web-tree-sitter";
import * as path from "path";
import {
  resolveSymbols,
  isClassLikeSymbol,
  isMethodSymbol,
  isFieldSymbol,
  isEnumMemberSymbol,
  isConstructorSymbol,
} from "./SymbolResolver.js";
import { parseTagTable } from "./TagParser.js";
import { gitService } from "../services/GitService.js";
import { TreeSitterService } from "../services/TreeSitterService.js";
import type {
  ClassDoc,
  MethodDoc,
  MethodKind,
  FieldDoc,
  EnumConstantDoc,
  TagTable,
  AccessModifier,
  GitAuthorInfo,
  TypeGroupInfo,
} from "../types.js";
import { MethodId, LineNumber, FilePath } from "../types.js";
import { createEmptyTagTable } from "../parser/TagParser.js";

// ========== 内部类型 ==========

/**
 * 扁平化后的符号信息
 *
 * 【为什么需要扁平化？】
 * Symbol 树是嵌套的（类 → 内部类 → 方法），
 * 我们需要把所有成员提取到同一层级，附带 belongsTo 记录归属关系
 */
interface FlattenedSymbol {
  readonly symbol: DocumentSymbol;
  readonly belongsTo: string; // 所属类名，如 "OuterClass.InnerClass"
}

// ========== 解析器 ==========

/**
 * Javadoc 解析器
 */
export class JavaDocParser {
  // 匹配 Javadoc 注释块 /** ... */
  private readonly javadocPattern = /\/\*\*[\s\S]*?\*\//;

  // 匹配 Java 注解 @Override, @Transactional 等
  private readonly annotationPattern = /^\s*@[\w.]+/;

  // 顶层类型声明（class/interface/enum/record/@interface）匹配
  private readonly topLevelTypePattern =
    /^\s*(?:@[\w.]+(?:\([^)]*\))?\s+)*(?:(?:public|protected|private|abstract|final|static|sealed|non-sealed|strictfp)\s+)*(?:class|interface|enum|record|@interface)\s+([A-Za-z_$][\w$]*)\b/;

  /**
   * 解析 Java 文档
   *
   * @param document - VS Code 的文档对象
   * @returns 解析后的类文档结构
   */
  public async parse(document: TextDocument): Promise<ClassDoc> {
    const symbols = await resolveSymbols(document.uri);
    const text = document.getText();
    const filePath = document.uri.fsPath;
    const languageId = document.languageId;

    // ---- Tree-sitter AST 解析 ----
    // 用于精确提取字段类型和方法签名，失败时回退到文本解析
    let tree: Tree | null = null;
    if (TreeSitterService.isLanguageSupported(languageId)) {
      try {
        const tsService = TreeSitterService.getInstance();
        tree = await tsService.parse(text, languageId);
      } catch (error) {
        console.error("[JavaDocParser] Tree-sitter parse failed:", error);
      }
    }

    // 步骤 2：提取类信息
    const classSymbol = this.findClassSymbol(symbols, filePath);
    const fallbackClassInfo = classSymbol
      ? null
      : this.extractPrimaryTypeInfoFromText(text, filePath);

    // 大标题统一用文件名（去扩展名）
    const fileName = path.basename(filePath, path.extname(filePath));
    const className = fileName;
    const packageName = this.extractPackageName(text);
    const classLine =
      classSymbol?.selectionRange?.start.line ??
      classSymbol?.range.start.line ??
      fallbackClassInfo?.classLine ??
      0;

    // 提取注释：优先类注释，其次文件头注释
    const fileHeaderComment = this.extractFileHeaderComment(text);

    // 收集所有类型（类/接口/枚举）的注释和标签
    // 用于多类型文件中，每个类型卡片内独立渲染各自的注释
    const typeGroups: TypeGroupInfo[] = this.collectTypeGroups(
      symbols,
      text,
      "",
      fileHeaderComment,
    );

    // 回退：LSP 未识别到类型但文本解析找到了
    if (typeGroups.length === 0 && fallbackClassInfo) {
      const fbComment = this.extractComment(text, fallbackClassInfo.classLine);
      if (fbComment && fbComment !== fileHeaderComment) {
        const parsed = this.parseJavadoc(fbComment, "");
        typeGroups.push({
          typeName: fallbackClassInfo.className,
          comment: parsed.description,
          tags: parsed.tags,
          startLine: fallbackClassInfo.classLine,
        });
      }
    }

    // 确定文件级注释和标签
    // 单类型：使用该类型的注释（与之前行为一致）
    // 多类型/无类型：使用文件头注释作为全局注释
    let classDescription = "";
    let classTags: TagTable = createEmptyTagTable();
    if (typeGroups.length === 1) {
      const single = typeGroups[0];
      if (single) {
        classDescription = single.comment;
        classTags = single.tags;
      }
    } else {
      const parsed = this.parseJavadoc(fileHeaderComment, "");
      classDescription = parsed.description;
      classTags = parsed.tags;
    }

    // @author/@since 从文件级标签提取
    const javadocAuthor = classTags.author ?? undefined;
    const javadocSince = classTags.since ?? undefined;

    // 原始类注释（用于 Lombok 等符号的误关联去重）
    // 单类型时使用该类型的原始注释，多类型时使用文件头
    const rawClassComment =
      (classSymbol ? this.extractComment(text, classLine) : "") ||
      fileHeaderComment ||
      "";

    // ---- 扁平化 Symbol 树 ----
    const flattenedSymbols = this.flattenSymbols(symbols, "");

    // ---- 按类别分别解析 ----
    // 传入 rawClassComment 用于排除 Lombok 等工具生成的符号误关联类注释的情况
    // 例如 @Slf4j 生成的 log 字段，Language Server 将其位置报告在类声明附近，
    // extractComment 向上搜索会错误地找到类 Javadoc
    const methods = flattenedSymbols
      .filter((fs) => isMethodSymbol(fs.symbol))
      .map((fs) => this.parseMethod(text, fs, rawClassComment, tree))
      .filter((m): m is MethodDoc => m !== null)
      .sort((a, b) => a.startLine - b.startLine);

    const fields = flattenedSymbols
      .filter((fs) => isFieldSymbol(fs.symbol))
      .map((fs) => this.parseField(text, fs, rawClassComment, tree))
      .filter((f): f is FieldDoc => f !== null)
      .sort((a, b) => a.startLine - b.startLine);

    const enumConstants = flattenedSymbols
      .filter((fs) => isEnumMemberSymbol(fs.symbol))
      .map((fs) => this.parseEnumConstant(text, fs, rawClassComment))
      .filter((e): e is EnumConstantDoc => e !== null)
      .sort((a, b) => a.startLine - b.startLine);

    // ---- Git 信息（异步，不阻塞主流程） ----
    const gitInfo = await this.getGitInfo(filePath, classLine);

    return {
      className,
      classComment: classDescription,
      classTags,
      typeGroups,
      packageName,
      filePath: FilePath(filePath),
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
  private flattenSymbols(
    symbols: readonly DocumentSymbol[],
    parentName: string,
  ): readonly FlattenedSymbol[] {
    const result: FlattenedSymbol[] = [];

    for (const symbol of symbols) {
      if (isClassLikeSymbol(symbol)) {
        // Class/Interface/Enum → 递归处理子符号，更新类名
        const currentClass = parentName
          ? `${parentName}.${symbol.name}`
          : symbol.name;

        if (symbol.children.length > 0) {
          result.push(...this.flattenSymbols(symbol.children, currentClass));
        }
      } else if (
        isMethodSymbol(symbol) ||
        isFieldSymbol(symbol) ||
        isEnumMemberSymbol(symbol)
      ) {
        result.push({
          symbol,
          belongsTo: parentName || "Unknown",
        });
      } else if (symbol.children.length > 0) {
        // 其他容器（Namespace/Module/Struct/Object 等）→ 递归但不更新类名
        result.push(...this.flattenSymbols(symbol.children, parentName));
      }
    }

    return result;
  }

  /**
   * 收集所有类型（类/接口/枚举）的注释和标签
   *
   * 与 flattenSymbols 类似的递归结构，但收集的是类型本身的注释，
   * 而非类型的成员。用于多类型文件中各类型卡片内的注释渲染。
   *
   * @param fileHeaderComment - 文件头注释原文，用于去重（避免第一个类误关联文件头）
   */
  private collectTypeGroups(
    symbols: readonly DocumentSymbol[],
    text: string,
    parentName: string,
    fileHeaderComment: string,
  ): TypeGroupInfo[] {
    const groups: TypeGroupInfo[] = [];

    for (const symbol of symbols) {
      if (isClassLikeSymbol(symbol)) {
        const currentName = parentName
          ? `${parentName}.${symbol.name}`
          : symbol.name;

        const line =
          symbol.selectionRange?.start.line ?? symbol.range.start.line;
        let rawComment = this.extractComment(text, line);

        // 去重：如果提取到的注释与文件头相同，视为误关联，置空
        if (
          fileHeaderComment &&
          rawComment.trim() === fileHeaderComment.trim()
        ) {
          rawComment = "";
        }

        const { description, tags } = this.parseJavadoc(rawComment, "");
        groups.push({
          typeName: currentName,
          comment: description,
          tags,
          startLine: line,
        });

        // 递归处理内部类
        if (symbol.children.length > 0) {
          groups.push(
            ...this.collectTypeGroups(
              symbol.children,
              text,
              currentName,
              fileHeaderComment,
            ),
          );
        }
      } else if (symbol.children.length > 0) {
        // 其他容器（Namespace/Module 等）→ 递归但不更新类型名
        groups.push(
          ...this.collectTypeGroups(
            symbol.children,
            text,
            parentName,
            fileHeaderComment,
          ),
        );
      }
    }

    return groups;
  }

  // ========== 方法解析 ==========

  /**
   * 解析单个方法（包括构造函数）
   *
   * 构造函数与普通方法走同一解析路径，
   * 仅在最终赋值 kind 时通过 isConstructorSymbol 区分
   */
  private parseMethod(
    text: string,
    flattened: FlattenedSymbol,
    classComment: string,
    tree: Tree | null,
  ): MethodDoc | null {
    try {
      const { symbol, belongsTo } = flattened;
      const lines = text.split("\n");

      const startLine = LineNumber(
        symbol.selectionRange?.start.line ?? symbol.range.start.line,
      );
      const endLine = LineNumber(symbol.range.end.line);

      const fullSignature = this.extractFullSignature(lines, startLine);
      const rawComment = this.extractMemberComment(
        text,
        startLine,
        classComment,
      );
      const hasComment = rawComment.length > 0;

      const { description, tags } = hasComment
        ? this.parseJavadoc(rawComment, fullSignature)
        : { description: "", tags: createEmptyTagTable() };

      const accessModifier = this.extractAccessModifierFromLine(fullSignature);
      const kind: MethodKind = isConstructorSymbol(symbol)
        ? "constructor"
        : "method";

      const displaySignature =
        symbol.detail || this.extractSignatureFromLine(lines[startLine] ?? "");

      // ---- 提取参数和返回类型：Tree-sitter → 文本解析回退 ----
      let params = "";
      let returnType = "";
      if (tree) {
        const sig = TreeSitterService.getInstance().extractMethodSignature(
          tree,
          startLine,
        );
        if (sig) {
          params = sig.params;
          returnType = sig.returnType;
        }
      }

      // 文本解析回退：当 tree-sitter 未提取到时，从签名文本中解析
      if (!params) {
        params = this.extractParamsFromSignature(displaySignature);
      }
      if (!returnType && kind !== "constructor") {
        returnType = this.extractReturnTypeFromSignature(
          displaySignature,
          symbol.name,
        );
      }

      // 构造函数没有返回类型
      if (kind === "constructor") {
        returnType = "";
      }

      return {
        id: MethodId(`${symbol.name}_${startLine}`),
        kind,
        name: symbol.name,
        signature: displaySignature,
        params,
        returnType,
        startLine,
        endLine,
        hasComment,
        description,
        tags,
        belongsTo,
        accessModifier,
      };
    } catch (error) {
      console.error(
        `[JavaDocParser] Failed to parse method: ${flattened.symbol.name}`,
        error,
      );
      return null;
    }
  }

  // ========== 字段解析 ==========

  /**
   * 解析单个字段（普通字段 / static final 常量）
   *
   * 类型提取优先级：
   * 1. Tree-sitter AST（最精确，直接从语法树取 type 节点）
   * 2. LSP symbol.detail（Language Server 提供的类型信息）
   * 3. 文本解析（正则 + 声明行分析，兜底方案）
   */
  private parseField(
    text: string,
    flattened: FlattenedSymbol,
    classComment: string,
    tree: Tree | null,
  ): FieldDoc | null {
    try {
      const { symbol, belongsTo } = flattened;
      const lines = text.split("\n");

      const startLine = LineNumber(
        symbol.selectionRange?.start.line ?? symbol.range.start.line,
      );
      const lineText = lines[startLine]?.trim() ?? "";

      const rawComment = this.extractMemberComment(
        text,
        startLine,
        classComment,
      );
      const hasComment = rawComment.length > 0;

      // 解析 JSDoc 标签（如 @type {string}），分离描述与标签
      const { description: parsedDesc, tags } = hasComment
        ? this.parseJavadoc(rawComment, "")
        : { description: "", tags: createEmptyTagTable() };

      // 若主描述为空但 @type 标签有描述（如 /** @type {string} 名称 */），回退使用
      const description =
        parsedDesc || tags.type?.description || "";

      const isConstant =
        lineText.includes("static") && lineText.includes("final");
      const accessModifier = this.extractAccessModifierFromLine(lineText);

      // ---- 类型提取：JSDoc @type → Tree-sitter → LSP detail → 文本解析 ----
      let fieldType = "";
      // JSDoc @type {Type} 优先（注释中的类型声明覆盖推断类型）
      if (tags.type?.type) {
        fieldType = tags.type.type;
      } else if (tree) {
        const tsType = TreeSitterService.getInstance().extractFieldType(
          tree,
          startLine,
        );
        if (tsType) {
          fieldType = tsType;
        }
      }
      if (!fieldType) {
        fieldType =
          this.cleanFieldTypeDetail(symbol.detail, symbol.name) ||
          this.extractFieldType(lineText, symbol.name);
      }

      return {
        name: symbol.name,
        type: fieldType,
        signature: lineText,
        startLine,
        hasComment,
        description,
        tags,
        isConstant,
        accessModifier,
        belongsTo,
      };
    } catch (error) {
      console.error(
        `[JavaDocParser] Failed to parse field: ${flattened.symbol.name}`,
        error,
      );
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
  private parseEnumConstant(
    text: string,
    flattened: FlattenedSymbol,
    classComment: string,
  ): EnumConstantDoc | null {
    try {
      const { symbol, belongsTo } = flattened;
      const lines = text.split("\n");

      const startLine = LineNumber(
        symbol.selectionRange?.start.line ?? symbol.range.start.line,
      );
      const lineText = lines[startLine]?.trim() ?? "";

      const rawComment = this.extractMemberComment(
        text,
        startLine,
        classComment,
      );
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
    } catch (error) {
      console.error(
        `[JavaDocParser] Failed to parse enum constant: ${flattened.symbol.name}`,
        error,
      );
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
  private extractEnumArguments(lineText: string): string {
    const openIndex = lineText.indexOf("(");
    if (openIndex === -1) return "";

    let depth = 0;
    for (let i = openIndex; i < lineText.length; i++) {
      const ch = lineText[i];
      if (ch === "(") depth++;
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
  private extractMemberComment(
    text: string,
    targetLine: number,
    classComment: string,
  ): string {
    const raw = this.extractComment(text, targetLine);
    if (raw.length === 0) return "";

    // 如果与类注释相同，说明是 Lombok 生成符号的误关联
    if (classComment.length > 0 && raw === classComment) return "";

    return raw;
  }

  /**
   * 解析 Javadoc 注释内容
   */
  private parseJavadoc(
    rawComment: string,
    signature: string,
  ): { description: string; tags: TagTable } {
    const cleaned = this.cleanComment(rawComment);
    const tagIndex = cleaned.search(/@\w+/);

    const description =
      tagIndex === -1 ? cleaned : cleaned.slice(0, tagIndex).trim();
    const rawTags = tagIndex === -1 ? "" : cleaned.slice(tagIndex);
    const tags = parseTagTable(rawTags, signature);

    return { description, tags };
  }

  /**
   * 清理 Javadoc 注释格式
   */
  private cleanComment(raw: string): string {
    return raw
      .replace(/\r\n/g, "\n")
      .replace(/\/\*\*|\*\//g, "")
      .split("\n")
      .map((line) => line.replace(/^\s*\*\s?/, ""))
      .map((line) => line.replace(/^\s*\/\/\s?/, ""))
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
  private static readonly MAX_SIGNATURE_LINES = 15;

  private extractFullSignature(lines: string[], startLine: number): string {
    let signature = "";
    let lineIndex = startLine;
    let parenDepth = 0;
    let foundOpenParen = false;
    const maxLine = Math.min(
      lines.length,
      startLine + JavaDocParser.MAX_SIGNATURE_LINES,
    );

    while (lineIndex < maxLine) {
      const line = lines[lineIndex] ?? "";

      for (const char of line) {
        signature += char;

        if (char === "(") {
          foundOpenParen = true;
          parenDepth++;
        } else if (char === ")") {
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
   * 提取文件头部注释 —— 文件开头第一个块注释（Javadoc 风格或普通块注释），
   * 且注释之后紧跟第一个声明（不要求紧邻，允许空行）。
   * 用于无类声明或多类型文件时，展示文件级说明。
   */
  private extractFileHeaderComment(text: string): string {
    const lines = text.split("\n");
    let i = 0;
    // 跳过开头空行和行内注释（// ...）和 pragma/shebang
    while (i < lines.length) {
      const trimmed = lines[i]?.trim() ?? "";
      if (trimmed === "" || trimmed.startsWith("//") || trimmed.startsWith("#")) {
        i++;
        continue;
      }
      break;
    }
    // 期望当前位置是块注释开始
    const startLine = i;
    const startTrimmed = lines[startLine]?.trim() ?? "";
    if (!startTrimmed.startsWith("/*")) {
      return "";
    }
    // 单行块注释 /* ... */
    if (startTrimmed.endsWith("*/") && startTrimmed.length > 2) {
      return lines[startLine] ?? "";
    }
    // 多行块注释：向下找 "*/"
    for (let j = startLine + 1; j < lines.length; j++) {
      if ((lines[j] ?? "").includes("*/")) {
        return lines.slice(startLine, j + 1).join("\n");
      }
    }
    return "";
  }

  /**
   * 提取目标行上方最近的 Javadoc 注释块
   */
  private extractComment(text: string, targetLine: number): string {
    const lines = text.split("\n");

    // 1. 从目标行向上找最近的块注释 /** ... */
    for (let endLine = targetLine - 1; endLine >= 0; endLine--) {
      const trimmed = lines[endLine]?.trim() ?? "";
      if (trimmed === "") continue;
      if (!trimmed.endsWith("*/")) continue;

      const between = lines.slice(endLine + 1, targetLine);
      if (!this.onlyBlankOrAnnotations(between)) continue;

      // 从 endLine 向上找对应的 "/**"
      for (let startLine = endLine; startLine >= 0; startLine--) {
        const line = lines[startLine] ?? "";
        if (line.includes("/**")) {
          return lines.slice(startLine, endLine + 1).join("\n");
        }
        // 遇到另一个块注释结束，说明不在同一个注释块内了
        if (startLine !== endLine && line.includes("*/")) break;
      }
    }

    // 2. 尝试 // 单行注释（行尾注释或上方连续行注释）
    const collectedLines: string[] = [];

    // 向上收集连续的 // 行注释
    for (let line = targetLine - 1; line >= 0; line--) {
      const trimmed = (lines[line] ?? "").trim();
      if (trimmed.startsWith("//")) {
        collectedLines.unshift(trimmed);
      } else if (trimmed === "") {
        continue;
      } else {
        break;
      }
    }

    // 检查目标行本身是否有行尾 // 注释
    const targetText = lines[targetLine] ?? "";
    const commentIdx = targetText.lastIndexOf("//");
    if (commentIdx >= 0) {
      collectedLines.push(targetText.substring(commentIdx).trim());
    }

    if (collectedLines.length > 0) {
      return collectedLines.join("\n");
    }

    return "";
  }

  /**
   * 判断一段代码是否仅由空行或注解（含多行注解参数）构成
   */
  private onlyBlankOrAnnotations(lines: readonly string[]): boolean {
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

  private extractAccessModifierFromLine(line: string): AccessModifier {
    if (line.includes("public ")) return "public";
    if (line.includes("protected ")) return "protected";
    if (line.includes("private ")) return "private";
    return "default";
  }

  /**
   * 从代码行中提取方法签名
   */
  private extractSignatureFromLine(line: string): string {
    // 移除方法体部分（如果在同一行）
    const withoutBody = line.replace(/\{.*$/, "").trim();
    return withoutBody || line;
  }

  /**
   * 从方法签名文本中提取参数列表（括号内内容）
   *
   * Tree-sitter 失败时的回退方案。
   *
   * @example
   *   "rebirth_tag(num m = 1, num a = 0) : MUL(m)" → "num m = 1, num a = 0"
   *   "merge(const rebirth_tag &L, const rebirth_tag &R)" → "const rebirth_tag &L, const rebirth_tag &R"
   *   "foo()" → ""
   */
  private extractParamsFromSignature(signature: string): string {
    if (!signature) return "";
    const openIdx = signature.indexOf("(");
    if (openIdx === -1) return "";

    let depth = 0;
    for (let i = openIdx; i < signature.length; i++) {
      if (signature[i] === "(") {
        depth++;
      } else if (signature[i] === ")") {
        depth--;
        if (depth === 0) {
          return signature.substring(openIdx + 1, i).trim();
        }
      }
    }
    // 括号未闭合，取 ( 之后全部
    return signature.substring(openIdx + 1).trim();
  }

  /**
   * 从方法签名文本中提取返回类型
   *
   * Tree-sitter 失败时的回退方案。取第一个 ( 之前的内容，
   * 去掉方法名和声明关键字。
   *
   * @example
   *   "static rebirth_tag merge(const ...)" → "rebirth_tag"
   *   "rebirth_tag(const rebirth_tag &L, ...)" → "rebirth_tag"
   *   "void foo()" → "void"
   */
  private extractReturnTypeFromSignature(
    signature: string,
    methodName: string,
  ): string {
    if (!signature) return "";
    const openIdx = signature.indexOf("(");
    if (openIdx === -1) return "";
    let beforeParen = signature.substring(0, openIdx).trim();
    // 去掉末尾的方法名
    if (methodName && beforeParen.endsWith(methodName)) {
      beforeParen = beforeParen.slice(0, -methodName.length).trim();
    }
    // 去掉前缀声明关键字（可能多个）
    beforeParen = beforeParen.replace(
      /^(?:(?:static|const|constexpr|inline|virtual|override|final|explicit|implicit|synchronized|native|abstract|async|friend|extern|register|volatile|public|private|protected)\s+)+/,
      "",
    );
    return beforeParen;
  }

  /**
   * 从 Symbol 列表中找到类符号
   */
  private findClassSymbol(
    symbols: readonly DocumentSymbol[],
    filePath: string,
  ): DocumentSymbol | undefined {
    const classLikes = symbols.filter((s) => isClassLikeSymbol(s));
    if (classLikes.length === 0) return undefined;

    const baseName = path.basename(filePath, path.extname(filePath));
    const matched = classLikes.find((s) => s.name === baseName);
    return matched ?? classLikes[0];
  }

  /**
   * 从文本中提取类名（Symbol 解析失败时的降级方案）
   */
  private extractClassNameFromText(text: string): string | undefined {
    const match = /(?:class|interface|enum)\s+(\w+)/.exec(text);
    return match?.[1];
  }

  /**
   * 当符号解析失败时，从源码文本中提取“主类型”(top-level)信息
   *
   * - 只识别 braceDepth===0 的类型声明，避免误选内部类
   * - 优先选择与文件名同名的类型（常见 Java 约定）
   */
  private extractPrimaryTypeInfoFromText(
    text: string,
    filePath: string,
  ): { className: string; classLine: number; classComment: string } | null {
    const lines = text.split("\n");
    const baseName = path.basename(filePath, path.extname(filePath));

    let braceDepth = 0;
    let state: ParseState = {
      inBlockComment: false,
      inString: false,
      inChar: false,
    };

    let first: { name: string; line: number } | null = null;
    let preferred: { name: string; line: number } | null = null;

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
    if (!chosen) {
      return null;
    }
    const classLine = chosen.line;
    const classComment = this.extractComment(text, classLine);
    return { className: chosen.name, classLine, classComment };
  }

  /**
   * 用于顶层扫描时剔除注释/字符串，避免 braceDepth 计算误差
   */
  private parseLineForStructure(
    line: string,
    state: ParseState,
  ): {
    code: string;
    openBraces: number;
    closeBraces: number;
    state: ParseState;
  } {
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

      if (ch === "{") openBraces++;
      if (ch === "}") closeBraces++;

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
   *
   * 支持的场景：
   *   "private static final int MAX_SIZE = 100;" → "int"
   *   "num S; // comment"                       → "num"
   *   "num MUL, ADD;"                            → "num" (多变量声明)
   *   "std::array<int, 10> arr;"                 → "std::array<int, 10>" (模板类型)
   *   "const int& ref = x;"                      → "int&"
   *
   * @param line       - 字段声明行
   * @param symbolName - 符号名（可选，帮助定位变量名位置）
   */
  private extractFieldType(line: string, symbolName?: string): string {
    // 先剥离行尾 // 注释
    const commentIdx = line.lastIndexOf("//");
    let code = commentIdx >= 0 ? line.substring(0, commentIdx) : line;
    // 剥离块注释
    code = code.replace(/\/\*[\s\S]*?\*\//g, "");

    // 同行多语句处理：按 ; 分割为独立声明语句
    // 如 "int x; string y;" → ["int x", " string y"]
    const statements = this.splitBySeparatorOutsideBrackets(code, ";");

    // 如果有符号名，定位到包含该符号的语句
    let targetStmt = code;
    if (symbolName && statements.length > 1) {
      const found = statements.find((s) => this.containsWord(s, symbolName));
      if (found) {
        targetStmt = found;
      }
    }

    return this.extractTypeFromStatement(targetStmt, symbolName);
  }

  /**
   * 从单条声明语句中提取类型
   */
  private extractTypeFromStatement(
    stmt: string,
    symbolName?: string,
  ): string {
    // 去掉末尾分号和逗号
    const cleaned = stmt.replace(/[;,]$/, "").trim();

    // 找到第一个分隔符 , = [（在 <> 和 () 外层）
    // 分隔符标记第一个变量名结束，之前的最后一个 token 是变量名，再之前是类型
    const sepIdx = this.findFirstDeclSeparatorOutsideBrackets(cleaned);
    if (sepIdx > 0) {
      const beforeSep = cleaned.substring(0, sepIdx).trim();
      const tokens = beforeSep.split(/\s+/).filter((t) => t.length > 0);
      if (tokens.length >= 2) {
        return this.stripModifiers(tokens.slice(0, -1));
      }
    }

    // 回退：如果知道符号名，取符号名之前的内容
    if (symbolName) {
      const nameIdx = this.indexOfWord(cleaned, symbolName);
      if (nameIdx > 0) {
        const beforeName = cleaned.substring(0, nameIdx).trim();
        // 去掉末尾逗号（多变量声明中前面变量的逗号）
        const beforeComma = beforeName.replace(/,\s*\w+$/, "").trim();
        const tokens = beforeComma.split(/\s+/).filter((t) => t.length > 0);
        if (tokens.length > 0) {
          return this.stripModifiers(tokens);
        }
      }
    }

    // 最终回退：取倒数第二个 token
    const parts = cleaned.split(/\s+/).filter((p) => p.length > 0);
    if (parts.length >= 2) {
      return parts[parts.length - 2] ?? "unknown";
    }
    return "unknown";
  }

  /**
   * 按指定分隔符分割字符串（在 <> 和 () 外层）
   */
  private splitBySeparatorOutsideBrackets(
    str: string,
    separator: string,
  ): string[] {
    const result: string[] = [];
    let angleDepth = 0;
    let parenDepth = 0;
    let lastIdx = 0;

    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ch === "<") angleDepth++;
      else if (ch === ">") angleDepth = Math.max(0, angleDepth - 1);
      else if (ch === "(") parenDepth++;
      else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
      else if (angleDepth === 0 && parenDepth === 0 && ch === separator) {
        result.push(str.substring(lastIdx, i));
        lastIdx = i + 1;
      }
    }
    result.push(str.substring(lastIdx));
    return result;
  }

  /**
   * 检查字符串中是否包含完整单词
   */
  private containsWord(str: string, word: string): boolean {
    return this.indexOfWord(str, word) >= 0;
  }

  /**
   * 查找完整单词的索引（避免子串匹配）
   */
  private indexOfWord(str: string, word: string): number {
    const regex = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    const match = regex.exec(str);
    return match ? match.index : -1;
  }

  /**
   * 找到第一个声明分隔符 , = [（在 <> 和 () 外层）
   * 比 findFirstSeparatorOutsideBrackets 多了 = 作为分隔符
   */
  private findFirstDeclSeparatorOutsideBrackets(str: string): number {
    let angleDepth = 0;
    let parenDepth = 0;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ch === "<") angleDepth++;
      else if (ch === ">") angleDepth = Math.max(0, angleDepth - 1);
      else if (ch === "(") parenDepth++;
      else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
      else if (
        angleDepth === 0 &&
        parenDepth === 0 &&
        (ch === "," || ch === "=" || ch === "[")
      ) {
        return i;
      }
    }
    return -1;
  }

  /**
   * 在字符串中找到第一个位于 <> 和 () 外层的分隔符 , ; [
   * 避免误匹配模板参数中的逗号（如 std::array<int, 10>）
   */
  private findFirstSeparatorOutsideBrackets(str: string): number {
    let angleDepth = 0;
    let parenDepth = 0;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ch === "<") angleDepth++;
      else if (ch === ">") angleDepth = Math.max(0, angleDepth - 1);
      else if (ch === "(") parenDepth++;
      else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
      else if (
        angleDepth === 0 &&
        parenDepth === 0 &&
        (ch === "," || ch === ";" || ch === "[")
      ) {
        return i;
      }
    }
    return -1;
  }

  /** 声明修饰符集合 */
  private static readonly MODIFIER_SET = new Set([
    "private", "public", "protected", "static", "final", "readonly",
    "volatile", "transient", "mutable", "inline", "constexpr", "register",
    "extern", "const", "let", "var", "abstract", "synchronized", "native",
    "default", "strictfp", "sealed", "non-sealed", "friend", "virtual",
    "override", "explicit", "implicit", "async",
  ]);

  /**
   * 从 token 数组中去除修饰符，返回纯类型
   */
  private stripModifiers(tokens: readonly string[]): string {
    const typeTokens = tokens.filter((t) => !JavaDocParser.MODIFIER_SET.has(t));
    return typeTokens.length > 0 ? typeTokens.join(" ") : tokens.join(" ");
  }

  /**
   * 从 LSP 提供的 symbol.detail 中提取字段类型
   *
   * 不同语言的 detail 格式不同：
   *   TS/JS: "const x: number"  → "number"
   *   TS/JS: ": string"         → "string"
   *   Java:  "int"               → "int"
   *   C++:   "num S"             → "num" (去掉变量名)
   *   C++:   "num"               → "num" (纯类型)
   */
  private cleanFieldTypeDetail(
    detail: string,
    symbolName: string,
  ): string {
    if (!detail) return "";
    let trimmed = detail.trim();

    // TS/JS: "const x: number" 或 ": number" → 取冒号后的部分
    const colonIdx = trimmed.lastIndexOf(": ");
    if (colonIdx >= 0) {
      return trimmed.substring(colonIdx + 2).trim();
    }

    // 去掉声明关键字前缀（含 C++ 关键字）
    const declMatch = trimmed.match(
      /^(?:const|let|var|private|public|protected|static|final|readonly|volatile|transient|mutable|inline|constexpr|register|extern)\s+(.+)$/,
    );
    if (declMatch && declMatch[1]) {
      trimmed = declMatch[1].trim();
    }

    // 去掉末尾的分号、等号及初始化值
    trimmed = trimmed.replace(/[;=].*$/, "").trim();

    // 去掉末尾的变量名："num S" → "num", "int x" → "int"
    if (symbolName && trimmed.endsWith(symbolName)) {
      const withoutName = trimmed.slice(0, -symbolName.length).trim();
      if (withoutName) {
        return withoutName;
      }
    }

    // 纯类型名或无法进一步解析：直接使用
    return trimmed;
  }

  private extractPackageName(text: string): string {
    const match = /package\s+([\w.]+);/.exec(text);
    return match?.[1] ?? "";
  }

  // ========== Git 集成 ==========

  private async getGitInfo(
    filePath: string,
    classLine: number,
  ): Promise<GitAuthorInfo | undefined> {
    try {
      const isGitRepo = await gitService.isGitRepository(filePath);
      if (!isGitRepo) return undefined;

      const info = await gitService.getClassGitInfo(filePath, classLine);
      if (!info) return undefined;

      return {
        author: info.author,
        lastModifier: info.lastModifier,
        lastModifyDate: info.lastModifyDate,
      };
    } catch {
      return undefined;
    }
  }
}

interface ParseState {
  readonly inBlockComment: boolean;
  readonly inString: boolean;
  readonly inChar: boolean;
}
