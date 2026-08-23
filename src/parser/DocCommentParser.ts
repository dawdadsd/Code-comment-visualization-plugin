/**
 * DocCommentParser.ts - 文档注释主解析器
 *
 * **职责：**
 * 1. 调用 SymbolResolver 获取代码结构
 * 2. 从源代码中提取 Javadoc 注释
 * 3. 调用 TagParser 解析标签
 * 4. 组装成 ClassDoc 数据结构
 * 5. 获取 Git 作者信息
 *
 * **解析流程：**
 * TextDocument → Symbol树 → 扁平化符号列表 → 按类别分别解析 → ClassDoc
 *
 * **符号分类：**
 * Symbol 树中的符号被分为四类：
 *   Container（类/接口/枚举）→ 递归展开子符号
 *   Method / Constructor     → parseMethod（通过 kind 字段区分）
 *   Field / Constant         → parseField
 *   EnumMember               → parseEnumConstant（独立解析路径）
 *
 * @author xiaowu
 * @since 2026/02/04
 */

import * as vscode from "vscode";
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
import { METADATA_TAG_PATTERN } from "./tagConstants.js";
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
 * **为什么需要扁平化？：**
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
export class DocCommentParser {
  // 匹配 Javadoc 注释块 /** ... */
  private readonly javadocPattern = /\/\*\*[\s\S]*?\*\//;

  // 匹配 Java 注解 @Override, @Transactional 等
  private readonly annotationPattern = /^\s*@[\w.]+/;

  // 顶层类型声明（class/interface/enum/record/@interface）匹配
  private readonly topLevelTypePattern =
    /^\s*(?:@[\w.]+(?:\([^)]*\))?\s+)*(?:(?:public|protected|private|abstract|final|static|sealed|non-sealed|strictfp)\s+)*(?:class|interface|enum|record|@interface)\s+([A-Za-z_$][\w$]*)\b/;

  /**
   * 使用 // 行注释作为成员文档注释的语言（Go / Rust）。
   *
   * 其余语言的文档注释必须是「/** 块注释」形式，// 行注释不视为文档——
   * 避免 "// 排序辅助" 这类普通行注释被误当作 Javadoc 展示在方法卡片上。
   */
  private static readonly LINE_COMMENT_DOC_LANGUAGES = new Set(["go", "rust"]);


  /**
   * 解析 Java 文档
   *
   * @param document - VS Code 的文档对象
   * @returns 解析后的类文档结构
   */
  public async parse(document: TextDocument): Promise<ClassDoc> {
    let symbols = await resolveSymbols(document.uri);
    const text = document.getText();
    const filePath = document.uri.fsPath;
    const languageId = document.languageId;
    // 文档注释风格：仅 Go/Rust 等语言把 // 行注释视为成员文档
    const allowLineComments =
      DocCommentParser.LINE_COMMENT_DOC_LANGUAGES.has(languageId);

    // ---- Tree-sitter AST 解析 ----
    // 用于精确提取字段类型和方法签名，失败时回退到文本解析
    let tree: Tree | null = null;
    if (TreeSitterService.isLanguageSupported(languageId)) {
      try {
        const tsService = TreeSitterService.getInstance();
        tree = await tsService.parse(text, languageId);
      } catch (error) {
        console.error("[DocCommentParser] Tree-sitter parse failed:", error);
      }
    }

    // ---- AST 兜底成员提取 ----
    // LSP 符号为空时（未装语言扩展 / 文件不在 workspace），直接从 tree-sitter
    // AST 提取类型/方法/字段，构造与 LSP 同形状的 DocumentSymbol 树，
    // 复用下方既有的扁平化与解析链路，保证任何受支持语言都能出卡片。
    if (symbols.length === 0 && tree) {
      try {
        const astSymbols = TreeSitterService.getInstance().extractMembers(
          tree,
          languageId,
        );
        if (astSymbols.length > 0) {
          symbols = astSymbols;
          console.log(
            `[DocCommentParser] LSP symbols empty, tree-sitter AST fallback: ${astSymbols.length} top-level type(s)`,
          );
        }
      } catch (error) {
        console.error("[DocCommentParser] tree-sitter AST member fallback failed:", error);
      }
    }

    // 步骤 2：提取类信息
    const classSymbol = this.findClassSymbol(symbols, filePath);
    const fallbackClassInfo = classSymbol
      ? null
      : this.extractPrimaryTypeInfoFromText(
          text,
          filePath,
          allowLineComments,
        );

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
    const fileHeader = this.extractFileHeaderComment(text);
    const fileHeaderComment = fileHeader.text;

    // 收集所有类型（类/接口/枚举）的注释和标签
    // 用于多类型文件中，每个类型卡片内独立渲染各自的注释
    const typeGroups: TypeGroupInfo[] = this.collectTypeGroups(
      symbols,
      text,
      "",
      fileHeaderComment,
      allowLineComments,
    );

    // 回退：LSP 未识别到类型但文本解析找到了
    if (typeGroups.length === 0 && fallbackClassInfo) {
      const fbExtracted = this.extractCommentWithRange(
        text,
        fallbackClassInfo.classLine,
        allowLineComments,
      );
      const fbComment = fbExtracted.text;
      // 清理标记后比较，避免 fileHeaderComment 含 // 前缀导致比较失效
      if (
        fbComment &&
        this.cleanComment(fbComment) !==
        this.cleanComment(fileHeaderComment)
      ) {
        const parsed = this.parseJavadoc(fbComment, "");
        typeGroups.push({
          typeName: fallbackClassInfo.className,
          comment: parsed.description,
          tags: parsed.tags,
          startLine: fallbackClassInfo.classLine,
          commentStartLine:
            fbComment.trim() !== "" && fbExtracted.startLine >= 0
              ? fbExtracted.startLine
              : undefined,
        });
      }
    }

    // 确定文件级注释和标签
    // 有文件头注释 → 优先使用文件头（@file 注释）
    // 单类型且无文件头 → 使用该类型的注释
    // 多类型/无类型且无文件头 → 空
    let classDescription = "";
    let classTags: TagTable = createEmptyTagTable();
    const parsedFileHeader = this.parseJavadoc(fileHeaderComment, "");
    // 文件头判定：注释非空，且有描述文本或含结构化标签。
    // 仅含 @license/@author 等元数据的文件头（description 为空）同样应被识别，
    // 否则许可证等元数据会被整体丢弃（与 SPDX 行提取到 license 的语义一致）。
    const hasFileHeader =
      fileHeaderComment.trim() !== "" &&
      (parsedFileHeader.description.trim() !== "" ||
        DocCommentParser.hasAnyTags(parsedFileHeader.tags));

    if (hasFileHeader) {
      classDescription = parsedFileHeader.description;
      classTags = parsedFileHeader.tags;
    } else if (typeGroups.length === 1) {
      const single = typeGroups[0];
      if (single) {
        classDescription = single.comment;
        classTags = single.tags;
      }
    }

    // @author/@since 从文件级标签提取
    const docAuthor = classTags.author ?? undefined;
    const docSince = classTags.since ?? undefined;
    // 许可证从文件级标签提取（SPDX-License-Identifier 或 @license）
    const docLicense = classTags.license ?? undefined;

    // 原始类注释（用于 Lombok 等符号的误关联去重）
    // 单类型时使用该类型的原始注释，多类型时使用文件头
    const rawClassComment =
      (classSymbol
        ? this.extractComment(text, classLine, allowLineComments)
        : "") ||
      fileHeaderComment ||
      "";

    // 成员注释去重参考列表：类注释 + 文件头注释（去重）。
    // 需同时包含两者：当文件含类声明且类注释与文件头不同时，
    // rawClassComment 仅为类注释，成员命中文件头需与文件头比较才能去重。
    const dedupComments = [rawClassComment, fileHeaderComment]
      .filter((c) => c.length > 0)
      .filter((c, i, arr) => arr.indexOf(c) === i);

    // ---- 扁平化 Symbol 树 ----
    const flattenedSymbols = this.flattenSymbols(symbols, "");

    // TypeScript 参数属性（constructor 参数前的 private/public/protected/readonly
    // 修饰符）会被 LSP 报告为 Field 符号，但其 range 落在构造函数参数列表内、
    // 无独立声明行。单独渲染会误用构造函数行提取类型（如 "constructor(private"）
    // 与注释（泄漏构造函数 JSDoc）。它们已由构造函数卡片的 @param 文档覆盖，
    // 此处按 range 包含关系识别并从字段中排除。
    const constructorRanges = flattenedSymbols
      .filter((fs) => isConstructorSymbol(fs.symbol))
      .map((fs) => fs.symbol.range);

    // ---- 按类别分别解析 ----
    // 传入 dedupComments 用于排除 Lombok 等工具生成的符号误关联类注释的情况
    // 例如 @Slf4j 生成的 log 字段，Language Server 将其位置报告在类声明附近，
    // extractComment 向上搜索会错误地找到类 Javadoc
    //
    // 源码文本回退：当 LSP 将箭头函数/函数表达式报告为 Variable（而非 Function）
    // 且 detail 无函数签名（JS 无类型推断）未能识别时，通过直接检查符号范围
    // 源码文本兜底检测（精确匹配 => / function；对象字面量变量不会误判）。
    //
    // 注释块内幽灵符号过滤：LSP 偶尔将文件头 JSDoc 注释中的文字误识别为 Variable
    // 符号（如注释中的 "Name"），这些符号的行落在块注释内，需过滤掉。
    const isOutsideComment = (fs: FlattenedSymbol): boolean => {
      const line = fs.symbol.selectionRange?.start.line ?? fs.symbol.range.start.line;
      return !this.isLineInsideBlockComment(text, line);
    };

    const methods = flattenedSymbols
      .filter(
        (fs) =>
          !this.isExportStatement(fs, text) &&
          (isMethodSymbol(fs.symbol) ||
            this.isFunctionVariableFromSource(fs, text)) &&
          isOutsideComment(fs),
      )
      .map((fs) =>
        this.parseMethod(text, fs, dedupComments, tree, allowLineComments),
      )
      .filter((m): m is MethodDoc => m !== null)
      .sort((a, b) => a.startLine - b.startLine);

    const fields = flattenedSymbols
      .filter(
        (fs) =>
          !this.isExportStatement(fs, text) &&
          isFieldSymbol(fs.symbol) &&
          !this.isFunctionVariableFromSource(fs, text) &&
          !this.isParameterProperty(fs.symbol, constructorRanges) &&
          isOutsideComment(fs),
      )
      .map((fs) =>
        this.parseField(text, fs, dedupComments, tree, allowLineComments),
      )
      .filter((f): f is FieldDoc => f !== null)
      .sort((a, b) => a.startLine - b.startLine);

    const enumConstants = flattenedSymbols
      .filter(
        (fs) =>
          isEnumMemberSymbol(fs.symbol) && isOutsideComment(fs),
      )
      .map((fs) =>
        this.parseEnumConstant(text, fs, dedupComments, allowLineComments),
      )
      .filter((e): e is EnumConstantDoc => e !== null)
      .sort((a, b) => a.startLine - b.startLine);

    // ---- Git 信息（异步，不阻塞主流程） ----
    const gitInfo = await this.getGitInfo(filePath, classLine);

    return {
      className,
      classComment: classDescription,
      classTags,
      // 文件头注释起止行：仅当文件级注释确实来自文件头时提供，
      // 使侧边栏为文件头注释构建精确的滚动区间锚点
      fileHeaderStartLine: hasFileHeader ? fileHeader.startLine : undefined,
      fileHeaderEndLine: hasFileHeader ? fileHeader.endLine : undefined,
      typeGroups,
      packageName,
      filePath: FilePath(filePath),
      methods,
      fields,
      enumConstants,
      gitInfo,
      docAuthor,
      docSince,
      docLicense,
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
    allowLineComments: boolean,
  ): TypeGroupInfo[] {
    const groups: TypeGroupInfo[] = [];

    for (const symbol of symbols) {
      if (isClassLikeSymbol(symbol)) {
        const currentName = parentName
          ? `${parentName}.${symbol.name}`
          : symbol.name;

        const line =
          symbol.selectionRange?.start.line ?? symbol.range.start.line;

        // 过滤落在块注释内的幽灵类型符号（LSP 误识别）
        if (this.isLineInsideBlockComment(text, line)) {
          if (symbol.children.length > 0) {
            groups.push(
              ...this.collectTypeGroups(
                symbol.children,
                text,
                currentName,
                fileHeaderComment,
                allowLineComments,
              ),
            );
          }
          continue;
        }

        // 精确提取注释及其起始行（替代"声明行 - 注释行数"估算，
        // 注解/空行存在时估算会偏大，导致滚动锚点提前进入卡片区域）
        const extracted = this.extractCommentWithRange(
          text,
          line,
          allowLineComments,
        );
        let rawComment = extracted.text;

        // 去重：清理标记后比较，避免 fileHeaderComment 含 // 前缀导致比较失效
        // 仅当原始注释清理后与文件头清理后完全一致时才视为重复
        if (
          fileHeaderComment &&
          rawComment.trim() &&
          this.cleanComment(rawComment) ===
          this.cleanComment(fileHeaderComment)
        ) {
          rawComment = "";
        }

        const { description, tags } = this.parseJavadoc(rawComment, "");
        // 类注释起始行：注释块第一行在源码中的行号，
        // 用于侧边栏滚动锚点，使编辑器滚到类注释时侧边栏进入类型卡片区域
        const commentStartLine =
          rawComment.trim() !== "" && extracted.startLine >= 0
            ? extracted.startLine
            : undefined;
        groups.push({
          typeName: currentName,
          comment: description,
          tags,
          startLine: line,
          commentStartLine,
        });

        // 递归处理内部类
        if (symbol.children.length > 0) {
          groups.push(
            ...this.collectTypeGroups(
              symbol.children,
              text,
              currentName,
              fileHeaderComment,
              allowLineComments,
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
            allowLineComments,
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
    dedupComments: readonly string[],
    tree: Tree | null,
    allowLineComments: boolean,
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
        dedupComments,
        allowLineComments,
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
        `[DocCommentParser] Failed to parse method: ${flattened.symbol.name}`,
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
    dedupComments: readonly string[],
    tree: Tree | null,
    allowLineComments: boolean,
  ): FieldDoc | null {
    try {
      const { symbol, belongsTo } = flattened;
      const lines = text.split("\n");

      const startLine = LineNumber(
        symbol.selectionRange?.start.line ?? symbol.range.start.line,
      );
      // 字段结束行：优先用 LSP symbol.range.end.line（含完整初始化器、`]);` / `;` 等）
      // 无 range 时退化为 startLine
      const endLine = LineNumber(symbol.range?.end?.line ?? startLine);
      const lineText = lines[startLine]?.trim() ?? "";

      const rawComment = this.extractMemberComment(
        text,
        startLine,
        dedupComments,
        allowLineComments,
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
          symbol.selectionRange?.start.character ??
            symbol.range.start.character,
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
        endLine,
        hasComment,
        description,
        tags,
        isConstant,
        accessModifier,
        belongsTo,
      };
    } catch (error) {
      console.error(
        `[DocCommentParser] Failed to parse field: ${flattened.symbol.name}`,
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
    dedupComments: readonly string[],
    allowLineComments: boolean,
  ): EnumConstantDoc | null {
    try {
      const { symbol, belongsTo } = flattened;
      const lines = text.split("\n");

      const startLine = LineNumber(
        symbol.selectionRange?.start.line ?? symbol.range.start.line,
      );
      // 枚举常量结束行：优先用 LSP symbol.range.end.line（含构造参数、逗号/分号）
      const endLine = LineNumber(symbol.range?.end?.line ?? startLine);
      const lineText = lines[startLine]?.trim() ?? "";

      const rawComment = this.extractMemberComment(
        text,
        startLine,
        dedupComments,
        allowLineComments,
      );
      const hasComment = rawComment.length > 0;
      const description = hasComment ? this.cleanComment(rawComment) : "";

      const args = this.extractEnumArguments(lineText);

      return {
        name: symbol.name,
        startLine,
        endLine,
        hasComment,
        description,
        arguments: args,
        belongsTo,
      };
    } catch (error) {
      console.error(
        `[DocCommentParser] Failed to parse enum constant: ${flattened.symbol.name}`,
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
   * **为什么需要这个方法？：**
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
    dedupComments: readonly string[],
    allowLineComments: boolean,
  ): string {
    const raw = this.extractComment(text, targetLine, allowLineComments);
    if (raw.length === 0) return "";

    // 如果与类注释或文件头注释相同，说明是 Lombok 生成符号的误关联，
    // 或成员紧随文件头导致 extractComment 向上回溯命中文件头。
    // 清理标记后比较，避免原始文本因 // 前缀或边界空行差异导致去重失效
    // （与 collectTypeGroups 的去重方式保持一致）。
    // 需同时比较类注释和文件头注释：当文件含类声明且类注释与文件头不同时，
    // rawClassComment 仅为类注释，成员命中文件头时需与文件头比较才能去重。
    const cleanedRaw = this.cleanComment(raw);
    for (const dedup of dedupComments) {
      if (dedup.length > 0 && cleanedRaw === this.cleanComment(dedup)) {
        return "";
      }
    }

    return raw;
  }

  /**
   * 行首锚定的 SPDX 许可标识行（无 @ 前缀，同样作为标签切分点）。
   *
   * 文件头只有 @file/@module 等非元数据标签时，METADATA_TAG_PATTERN
   * 找不到切分点，SPDX 行会混入描述文本；此处单独匹配，保证许可证
   * 无论是否跟在元数据标签后都能被提取。
   */
  private static readonly SPDX_LICENSE_PATTERN =
    /^SPDX-License-Identifier:\s*\S+/m;

  /**
   * 标签表是否含任何结构化标签。
   * 文件头判定用：description 为空时，只要有标签（如仅 @license）也算有效文件头。
   */
  private static hasAnyTags(tags: TagTable): boolean {
    return (
      tags.params.length > 0 ||
      tags.returns !== null ||
      tags.throws.length > 0 ||
      tags.since !== null ||
      tags.author !== null ||
      tags.license !== null ||
      tags.deprecated !== null ||
      tags.see.length > 0 ||
      tags.doc !== null ||
      tags.example !== null ||
      tags.type !== null ||
      tags.typedef !== null ||
      tags.properties.length > 0 ||
      tags.template.length > 0 ||
      tags.yields !== null ||
      tags.summary !== null ||
      tags.description !== null ||
      tags.todo.length > 0 ||
      tags.emits.length > 0 ||
      tags.listens.length > 0 ||
      tags.modifiers.length > 0
    );
  }

  /**
   * 解析 Javadoc 注释内容
   */
  private parseJavadoc(
    rawComment: string,
    signature: string,
  ): { description: string; tags: TagTable } {
    const cleaned = this.cleanComment(rawComment);
    const tagIndex = cleaned.search(METADATA_TAG_PATTERN);
    const spdxIndex = cleaned.search(DocCommentParser.SPDX_LICENSE_PATTERN);
    // 取两个切分点中更靠前的（SPDX 行也可能出现在无元数据标签的文件头中）
    const splitIndex =
      tagIndex === -1
        ? spdxIndex
        : spdxIndex === -1
          ? tagIndex
          : Math.min(tagIndex, spdxIndex);

    let description =
      splitIndex === -1 ? cleaned : cleaned.slice(0, splitIndex).trim();

    // 剥离 @file 标签名，其内容作为描述文本的一部分
    description = description.replace(/^@file[ \t]+/, "").trim();

    const rawTags = splitIndex === -1 ? "" : cleaned.slice(splitIndex);
    const tags = parseTagTable(rawTags, signature);

    return { description, tags };
  }

  /**
   * 清理 Javadoc 注释格式
   */
  private cleanComment(raw: string): string {
    return raw
      .replace(/\r\n/g, "\n")
      .replace(/\/\*\*?|\*\//g, "")
      .split("\n")
      .map((line) => line.replace(/^\s*\*\s?/, ""))
      // Rust 的 /// 与 //! 都属文档注释，按任意多个斜杠 + 可选空行标记清理
      .map((line) => line.replace(/^\s*\/{2,}[!\s]?/, ""))
      .join("\n")
      // 行尾 \ 续行标记（markdown 正常写法）：删除 \ 与其后的换行及续行行首缩进，
      // 将逻辑行拼接为一行（如 "...命中 \ 换行 前一个兄弟的..." → "...命中前一个兄弟的..."）
      .replace(/[ \t]*\\[ \t]*\n[ \t]*/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  /**
   * 检查指定行是否位于块注释（/​** ... *​/）内部。
   *
   * 设计原因：LSP 偶尔会将文件头 JSDoc 注释中的文字误识别为 Variable 符号
   * （例如注释中的 "Name" 被解析为变量），这些幽灵符号落在注释行上，
   * 不应渲染为字段/方法卡片。通过行扫描跟踪块注释状态即可过滤。
   */
  private isLineInsideBlockComment(text: string, lineIndex: number): boolean {
    const lines = text.split("\n");
    let inBlockComment = false;
    for (let i = 0; i <= lineIndex && i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (inBlockComment) {
        // 进入此行时仍在块注释中 → 此行属于注释
        if (i === lineIndex) return true;
        if (line.includes("*/")) {
          inBlockComment = false;
        }
        continue;
      }
      // 查找此行是否有块注释开始
      let idx = 0;
      while (idx < line.length) {
        const two = line.substring(idx, idx + 2);
        if (two === "//") {
          break; // 行注释，忽略剩余
        } else if (two === "/*") {
          inBlockComment = true;
          if (i === lineIndex) return true;
          // 检查是否在同一行结束
          const closeIdx = line.indexOf("*/", idx + 2);
          if (closeIdx >= 0) {
            inBlockComment = false;
            idx = closeIdx + 2;
          } else {
            break;
          }
        } else {
          idx++;
        }
      }
    }
    return false;
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

  /**
   * 通过源码文本检查 Variable 符号是否为函数表达式。
   *
   * 兜底检测：当 LSP 的 `detail` 和 `children` 都无法识别
   * （如 JS 文件中的一行箭头函数 `const f = (v) => v`）时，
   * 直接检查符号范围内的源码文本是否包含 `=>` 或 `function` 关键字。
   */
  private isFunctionVariableFromSource(
    flattened: FlattenedSymbol,
    text: string,
  ): boolean {
    const { symbol } = flattened;
    if (symbol.kind !== vscode.SymbolKind.Variable) {
      return false;
    }
    const lines = text.split("\n");
    const startLine = symbol.range.start.line;
    const endLine = symbol.range.end.line;
    const firstLine = lines[startLine]?.trim() ?? "";

    // 箭头函数
    if (firstLine.includes("=>")) {
      return true;
    }
    // function 表达式 / async function 表达式
    if (/\b(?:async\s+)?function\b/.test(firstLine)) {
      return true;
    }
    // 多行场景：逐行检查
    if (startLine !== endLine) {
      for (let i = startLine; i <= endLine; i++) {
        const line = lines[i]?.trim() ?? "";
        if (line.includes("=>")) {
          return true;
        }
        if (/\b(?:async\s+)?function\b/.test(line)) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * 检查符号是否为 export 语句（如 export { ... } 或 export * from ...）。
   *
   * TS/JS language server 会将 `export { foo }` 等 re-export 语句
   * 报告为 Variable 符号，应排除以避免误识别为字段。
   */
  private isExportStatement(
    flattened: FlattenedSymbol,
    text: string,
  ): boolean {
    const { symbol } = flattened;
    if (symbol.kind !== vscode.SymbolKind.Variable) {
      return false;
    }
    const lines = text.split("\n");
    const startLine = symbol.range.start.line;
    const firstLine = lines[startLine]?.trim() ?? "";
    return /^export\s*\{/.test(firstLine) || /^export\s*\*/.test(firstLine);
  }

  /**
   * 判断字段符号是否为 TypeScript 参数属性（constructor 参数上的访问修饰符
   * 声明的字段）。
   *
   * 参数属性的 range 落在某个构造函数的 range 内（构造函数参数列表），而普通
   * 字段声明位于类体顶层、不会落在任何构造函数体内。据此按 range 包含关系识别。
   */
  private isParameterProperty(
    symbol: DocumentSymbol,
    constructorRanges: readonly vscode.Range[],
  ): boolean {
    if (constructorRanges.length === 0) return false;
    return constructorRanges.some((ctorRange) =>
      this.rangeContains(ctorRange, symbol.range),
    );
  }

  /**
   * 判断 outer range 是否包含 inner range（含相等）。
   *
   * 直接比较 line/character 而非 Position.compareTo，以兼容测试 mock 的
   * 简化 Position 实现（无 compareTo 方法）。
   */
  private rangeContains(outer: vscode.Range, inner: vscode.Range): boolean {
    return (
      this.comparePosition(outer.start, inner.start) <= 0 &&
      this.comparePosition(outer.end, inner.end) >= 0
    );
  }

  /** 比较两个 Position：返回负数/0/正数，先按行再按字符。 */
  private comparePosition(a: vscode.Position, b: vscode.Position): number {
    if (a.line !== b.line) return a.line - b.line;
    return a.character - b.character;
  }

  private extractFullSignature(lines: string[], startLine: number): string {
    let signature = "";
    let lineIndex = startLine;
    let parenDepth = 0;
    let foundOpenParen = false;
    const maxLine = Math.min(
      lines.length,
      startLine + DocCommentParser.MAX_SIGNATURE_LINES,
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
   * 提取文件头部注释 —— 收集文件开头所有连续的注释片段：
   *   1. 连续的 // 行注释（包括空行间杂在内的 // 注释）
   *   2. /* ... * / 块注释（单行或多行）
   *   3. # 开头的 shebang/pragma
   *
   * 返回值附带注释在源码中的起止行（startLine / endLine），
   * 供侧边栏构建"文件头注释区间锚点"：编辑器在文件头注释内滚动时，
   * 侧边栏精确停留在文件头注释区域，而非被线性拉伸跨过整个区间。
   * 无注释时 startLine / endLine 均为 0。
   *
   * 用于在无类声明或多类型文件时，展示文件级说明。
   * 支持 // 行注释与 /* * / 块注释的混合组合。
   */
  private extractFileHeaderComment(text: string): {
    text: string;
    startLine: number;
    endLine: number;
  } {
    const lines = text.split("\n");
    const segments: string[] = [];
    let firstLine = 0;
    let lastLine = -1; // 无注释时为 -1，返回时归一为 0
    let i = 0;

    // Phase 1: 收集文件开头的 // 行注释片段
    // 允许注释间有空行（但空行打断后不再回溯）
    while (i < lines.length) {
      const trimmed = lines[i]?.trim() ?? "";
      if (trimmed === "" || trimmed.startsWith("#")) {
        i++;
        continue;
      }
      if (trimmed.startsWith("//")) {
        const segStart = i;
        while (i < lines.length) {
          const t = lines[i]?.trim() ?? "";
          if (t.startsWith("//") || t === "") {
            i++;
          } else {
            break;
          }
        }
        const seg = lines.slice(segStart, i).join("\n");
        if (seg.trim()) {
          segments.push(seg);
          firstLine = segStart;
          lastLine = i - 1;
        }
        break; // 只收集文件开头第一段连续的 // 注释
      } else {
        break;
      }
    }

    // Phase 2: 收集紧随其后的 /* ... */ 块注释
    if (i < lines.length) {
      // 跳过 // 注释与块注释之间可能存在的空行
      while (i < lines.length && (lines[i]?.trim() ?? "") === "") {
        i++;
      }
      const blockStart = i;
      const blockTrimmed = lines[blockStart]?.trim() ?? "";
      if (blockTrimmed.startsWith("/*")) {
        if (blockTrimmed.endsWith("*/") && blockTrimmed.length > 2) {
          segments.push(lines[blockStart] ?? "");
          lastLine = blockStart;
          i = blockStart + 1;
        } else {
          for (let j = blockStart + 1; j < lines.length; j++) {
            if ((lines[j] ?? "").includes("*/")) {
              segments.push(lines.slice(blockStart, j + 1).join("\n"));
              lastLine = j;
              i = j + 1;
              break;
            }
          }
        }
        // Phase 1 未收集到 // 段（文件直接以块注释开头，或前有 shebang/空行）
        // 时，以块注释起始行作为区间起点
        if (segments.length === 1) {
          firstLine = blockStart;
        }
      }
    }

    // Phase 3: 判定收集到的注释是否为真正的文件头注释。
    // 真正的文件头应描述整个文件（通常含 @file 标记）；若其后紧跟的是
    // const/let/var/function/type 等成员声明，则该注释属于第一个成员而非文件头。
    // 若不排除，第一个成员的 JSDoc 会被当作文件头消费，进而触发成员解析时
    // "与类注释相同"的去重逻辑（无类声明时 rawClassComment 回退为文件头），
    // 导致该成员的注释被误判为 Lombok 误关联而完全不显示。
    if (segments.length > 0) {
      let nextLine = i;
      while (nextLine < lines.length && (lines[nextLine]?.trim() ?? "") === "") {
        nextLine++;
      }
      const nextTrimmed = lines[nextLine]?.trim() ?? "";
      const isMemberDecl =
        /^(export\s+)?(const|let|var|function|async\s+function|type)\b/.test(
          nextTrimmed,
        );
      const hasFileTag = /@file\b/i.test(segments.join("\n"));
      if (isMemberDecl && !hasFileTag) {
        segments.length = 0;
        firstLine = 0;
        lastLine = -1;
      }
    }

    return {
      text: segments.join("\n"),
      startLine: segments.length > 0 ? firstLine : 0,
      endLine: lastLine >= 0 ? lastLine : 0,
    };
  }

  /**
   * 提取目标行上方最近的 Javadoc 注释块
   */
  private extractComment(
    text: string,
    targetLine: number,
    allowLineComments: boolean,
  ): string {
    return this.extractCommentWithRange(text, targetLine, allowLineComments)
      .text;
  }

  /**
   * 提取目标行上方最近的 Javadoc 注释块，附带注释起始行
   *
   * 起始行用于滚动锚点：注释块第一行在源码中的行号，
   * 使编辑器滚到注释首行时侧边栏恰好进入对应卡片区域。
   *
   * @param allowLineComments - 该语言的文档注释是否允许 // 行注释
   *   （Go/Rust 为 true；其余语言文档注释必须是「/** 块注释」形式，
   *   // 行注释不视为文档，避免被误当作 Javadoc 展示在成员卡片上）
   * @returns { text, startLine } startLine 为注释第一行行号（未找到时 -1）
   */
  private extractCommentWithRange(
    text: string,
    targetLine: number,
    allowLineComments: boolean,
  ): { text: string; startLine: number } {
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
          return {
            text: lines.slice(startLine, endLine + 1).join("\n"),
            startLine,
          };
        }
        // 遇到另一个块注释结束，说明不在同一个注释块内了
        if (startLine !== endLine && line.includes("*/")) break;
      }
    }

    // 2. 尝试 // 单行注释（行尾注释或上方连续行注释）
    //    仅当该语言的文档注释支持 // 行注释时才收集（Go/Rust），
    //    否则 // 行注释会被误当作 Javadoc 展示在成员卡片上
    const collectedLines: string[] = [];
    let firstLine = -1;

    if (allowLineComments) {
      // 向上收集连续的 // 行注释
      for (let line = targetLine - 1; line >= 0; line--) {
        const trimmed = (lines[line] ?? "").trim();
        if (trimmed.startsWith("//")) {
          collectedLines.unshift(trimmed);
          firstLine = line;
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
        if (firstLine < 0) firstLine = targetLine;
      }
    }

    if (collectedLines.length > 0) {
      return {
        text: collectedLines.join("\n"),
        startLine: firstLine,
      };
    }

    return { text: "", startLine: -1 };
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
    // 去掉前缀声明关键字（可能多个）；\s* 允许关键字后无空格
    // （如 trim 后的 "static"，\s+ 会匹配失败导致 "static" 被误当返回类型）
    // function/export：JS 函数声明 "function foo()" / "export function foo()"
    // 若无显式返回类型注解，返回类型应为空而非关键字本身
    beforeParen = beforeParen.replace(
      /^(?:(?:static|const|constexpr|inline|virtual|override|final|explicit|implicit|synchronized|native|abstract|async|function|export|friend|extern|register|volatile|public|private|protected)\s*)+/,
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
    allowLineComments: boolean,
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
    const classComment = this.extractComment(text, classLine, allowLineComments);
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
        const type = this.typeFromNameTokens(tokens);
        if (type) {
          // 多变量声明（int *a, b; / const int *p, q;）：符号名位于首个分隔符
          // 之后时，该变量继承公共类型（int / const int），不继承前一个变量
          // 的指针/引用后缀（*a / *p）
          if (
            symbolName &&
            this.indexOfWord(cleaned.substring(sepIdx), symbolName) >= 0
          ) {
            const common = this.stripModifiers(tokens.slice(0, -1));
            if (common) return common;
          }
          return type;
        }
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
          const type = this.stripModifiers(tokens);
          if (type) return type;
        }
      }
    }

    // JS 构造器初始化：const set = new Set() → 类型取构造器名 Set
    // （放在向后扫描之前，避免把 new / 构造器泛型参数误当类型）
    const ctorMatch =
      /=\s*new\s+([A-Za-z_$][\w$.]*(?:<[^()]*>)?)/.exec(cleaned);
    if (ctorMatch?.[1]) {
      return ctorMatch[1];
    }

    // 最终回退：从后向前找第一个「类型 token」。
    // 跳过声明关键字与 = [ 等非类型 token，避免取到初始化表达式内容
    const parts = cleaned.split(/\s+/).filter((p) => p.length > 0);
    for (let i = parts.length - 2; i >= 0; i--) {
      const token = parts[i] ?? "";
      if (token.startsWith("=") || token.startsWith("[")) break;
      // JS 构造器关键字不构成类型（构造器初始化已在上方处理）
      if (token === "new") continue;
      const type = this.stripModifiers([token]);
      if (type) return type;
    }
    return "unknown";
  }

  /**
   * 从「类型 + 变量名」token 数组中提取类型。
   *
   * 支持 C 系指针/引用/数组写法（符号紧贴变量名）：
   *   ["int", "*ptr"]   → "int *"
   *   ["char", "**pp"]  → "char **"
   *   ["unsigned", "int", "count"] → "unsigned int"
   *   ["int", "arr[10]"] → "int [10]"
   *
   * 若变量名前的 token 全为声明关键字（如 JS "let"），返回空字符串，
   * 由调用方继续走后续回退，避免把 "let" 当类型。
   *
   * @param tokens - 「类型 + 变量名」token 序列，最后一个为变量名
   * @returns 提取到的类型，无有效类型时返回空字符串
   */
  private typeFromNameTokens(tokens: readonly string[]): string {
    let nameToken = tokens[tokens.length - 1] ?? "";
    const typeTokens = tokens.slice(0, -1);

    // TS/JS 命名类型语法：`let x: number` 中变量名 token 带冒号（"x:"），
    // 冒号后的才是类型，由 cleanFieldTypeDetail 的冒号分支处理，此处返回空
    if (typeTokens.some((t) => t.endsWith(":"))) {
      return "";
    }

    // 指针/引用：`int *ptr` → 星号属于类型而非变量名
    const ptrMatch = /^[*&]+/.exec(nameToken);
    if (ptrMatch) {
      nameToken = nameToken.slice(ptrMatch[0].length);
      typeTokens.push(ptrMatch[0]);
    }
    // 数组：`int arr[10]` → 下标属于类型
    const bracketIdx = nameToken.indexOf("[");
    if (bracketIdx > 0) {
      typeTokens.push(nameToken.slice(bracketIdx));
    }
    const type = this.stripModifiers(typeTokens);
    return type.length > 0 ? type : "";
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
   * 从 token 数组中去除修饰符，返回纯类型。
   *
   * 过滤后为空时返回空字符串（而非回退原始 token），
   * 避免把声明关键字（如 JS "let"/"const"）误当类型；
   * 调用方需自行检查空值并回退。
   *
   * **C 系 const 例外**：const 在 C 中既是声明关键字（JS `const x`），
   * 也是类型修饰符（C `const int x`）。通过位置区分——const 位于 token 序列
   * 末尾（后面只有变量名）时是声明关键字，移除；位于类型 token 之前
   * （"const int"）时是类型修饰符，保留。
   */
  private stripModifiers(tokens: readonly string[]): string {
    const typeTokens = tokens.filter(
      (t, idx) =>
        !DocCommentParser.MODIFIER_SET.has(t) ||
        // C 系类型修饰符：const 后面还有类型 token 时属于类型的一部分
        (t === "const" && idx < tokens.length - 1),
    );
    return typeTokens.join(" ");
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
      // 变量名前只有声明关键字或没有类型信息（如 "const arr = [...]" → "arr"），
      // 返回空让调用方回退到文本解析，避免把变量名当类型
      return "";
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
