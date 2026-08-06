/**
 * SidebarProvider.ts - Webview 侧边栏管理器
 *
 * 【这是整个扩展的核心模块】
 *
 * 职责：
 * 1. 管理 Webview 的生命周期（创建、销毁）
 * 2. 协调解析器和前端的通信
 * 3. 处理双向联动逻辑
 *
 * 【WebviewViewProvider 是什么？】
 * VS Code 提供的接口，用于创建侧边栏中的 Webview
 * 实现这个接口，VS Code 就知道如何显示你的侧边栏
 * @author : xiaowu
 * @since : 2026/02/04
 */

import * as vscode from "vscode";
import * as path from "path";
import * as crypto from "crypto";
import type {
  WebviewView,
  WebviewViewProvider,
  WebviewViewResolveContext,
  CancellationToken,
  TextDocument,
  Disposable,
} from "vscode";
import { JavaDocParser } from "./parser/JavaDocParser.js";
import { debounce } from "./utils/debounce.js";
import { binarySearchMethod } from "./utils/binarySearch.js";
import type {
  MethodDoc,
  FieldDoc,
  EnumConstantDoc,
  DownstreamMessage,
} from "./types.js";
import { isSupportedLanguage, isUpstreamMessage, LineNumber } from "./types.js";

const HIGHLIGHT_DEBOUNCE_DELAY = 300;
const MARKDOWN_IMAGE_PATTERN = /!\[[^\]]*]\(([^)\n]+)\)/g;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[a-zA-Z]:[\\/]/;
const URI_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z\d+.-]*:/;

/**
 * TS/JS language server 分析 JSX/JS 文件时,首次 executeDocumentSymbolProvider
 * 可能返回空数组(还在后台分析)。此时延迟重试一次,避免侧边栏卡在"无成员"状态。
 */
const SLOW_INIT_LANGUAGES = new Set([
  "typescript",
  "typescriptreact",
  "javascript",
  "javascriptreact",
  "c",
  "cpp",
  "csharp",
  "objective-c",
  "kotlin",
  "scala",
  "groovy",
  "python",
  "ruby",
  "go",
  "rust",
  "php",
  "lua",
  "dart",
  "swift",
  "r",
  "vue",
  "svelte",
]);
const SYMBOL_EMPTY_RETRY_DELAY_MS = 1500;

/**
 * Webview 侧边栏 Provider
 * - WebviewViewProvider：VS Code 要求的接口，用于创建侧边栏
 * - Disposable：资源清理接口，扩展卸载时调用
 */
export class SidebarProvider implements WebviewViewProvider, Disposable {
  private view: WebviewView | undefined;
  private currentMethods: readonly MethodDoc[] = [];
  private currentFields: readonly FieldDoc[] = [];
  private currentEnumConstants: readonly EnumConstantDoc[] = [];
  private lastHighlightId: string | null = null;
  private readonly parser: JavaDocParser;
  private readonly debouncedHighlight: (line: number) => void;
  private webviewMessageDisposable: Disposable | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private symbolRetryToken: { uri: string; version: number } | null = null;

  /**
   * 构造函数
   *
   * @param extensionUri - 扩展的根目录 URI
   * Webview 需要加载 CSS/JS 文件，但出于安全考虑，
   * 它不能随意访问本地文件，只能访问 extensionUri 下的文件
   */
  constructor(private readonly extensionUri: vscode.Uri) {
    this.parser = new JavaDocParser();
    this.debouncedHighlight = debounce((line: number) => {
      this.updateHighlight(LineNumber(line));
    }, HIGHLIGHT_DEBOUNCE_DELAY);
  }
  /**
   * 解析 Webview ( called by vscode)
   *
   * @implNote 用户第一次点击侧边栏图标时，VS Code 会调用这个方法，
   *           让我们有机会配置和初始化 Webview
   *
   * @param webviewView - VS Code 创建的 Webview 容器
   * @param _context - 解析上下文（我们不需要）
   * @param _token - 取消令牌（我们不需要）
   */
  public resolveWebviewView(
    webviewView: WebviewView,
    _context: WebviewViewResolveContext,
    _token: CancellationToken,
  ): void {
    try {
      this.view = webviewView;
      this.configureWebview(webviewView.webview);
      this.registerWebviewMessageListener(webviewView.webview);
      void this.refresh();
    } catch (error) {
      console.error("[JavaDocSidebar] resolveWebviewView failed:", error);
    }
  }

  /**
   * 刷新侧边栏内容
   *
   * @param document - 要解析的文档，不传则使用当前活动文档
   *
   * 【async/await 解释】
   * async 函数返回 Promise，可以用 await 等待异步操作完成
   * 这里 parser.parse() 是异步的（需要调用 VS Code API）
   */
  public async refresh(document?: TextDocument): Promise<void> {
    const doc = this.getTargetSupportDocument(document);
    if (!doc) {
      this.clearView();
      return;
    }

    if (doc.languageId === "markdown") {
      this.refreshMarkdown(doc);
      return;
    }

    try {
      const classDoc = await this.parser.parse(doc);
      this.currentMethods = classDoc.methods;
      this.currentFields = classDoc.fields;
      this.currentEnumConstants = classDoc.enumConstants;
      this.lastHighlightId = null;
      this.postMessage({ type: "updateView", payload: classDoc });

      // TS/JS language server 对 JSX/JS 文件首次请求可能返回空符号(仍在后台分析)。
      // 此时安排一次延迟重试,避免侧边栏卡在"该类没有成员定义"。
      if (
        SLOW_INIT_LANGUAGES.has(doc.languageId) &&
        classDoc.methods.length === 0 &&
        classDoc.fields.length === 0 &&
        classDoc.enumConstants.length === 0
      ) {
        this.scheduleSymbolRetry(doc);
      }
    } catch (error) {
      console.error("[JavaDocSidebar] Parse error:", error);
    }
  }

  /**
   * 安排一次延迟重试,仅在 TS/JS 文件首次返回空符号时触发。
   * 同一 (uri, version) 只重试一次,避免无限循环。
   */
  private scheduleSymbolRetry(document: TextDocument): void {
    const token = { uri: document.uri.toString(), version: document.version };
    if (
      this.symbolRetryToken &&
      this.symbolRetryToken.uri === token.uri &&
      this.symbolRetryToken.version === token.version
    ) {
      return;
    }
    this.symbolRetryToken = token;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      const current = vscode.window.activeTextEditor?.document;
      if (
        current &&
        current.uri.toString() === token.uri &&
        current.version === token.version
      ) {
        void this.refresh(current);
      }
    }, SYMBOL_EMPTY_RETRY_DELAY_MS);
  }

  /**
   * 刷新 Markdown 预览
   */
  private refreshMarkdown(document: TextDocument): void {
    this.currentMethods = [];
    this.currentFields = [];
    this.currentEnumConstants = [];
    this.lastHighlightId = null;
    this.updateWebviewOptions(document);
    const content = document.getText();
    const fileName = path.basename(document.uri.fsPath);
    const imageMap = this.buildMarkdownImageMap(document, content);
    this.postMessage({
      type: "updateMarkdown",
      payload: { content, fileName, imageMap },
    });
  }

  /**
   * 清空视图
   */
  public clearView(): void {
    this.currentMethods = [];
    this.currentFields = [];
    this.currentEnumConstants = [];
    this.lastHighlightId = null;
    this.postMessage({ type: "clearView" });
  }

  /**
   * cn - 处理光标选择变化（从 extension.ts 调用）
   * en - handle selection change (called from extension.ts)
   * @param line - 光标所在行号
   */
  public handleSelectionChange(line: number): void {
    this.debouncedHighlight(line);
  }

  /**
   * 释放资源（Disposable 接口）
   *
   * 【何时被调用？】
   * 扩展被禁用或卸载时，VS Code 会调用这个方法
   * 让我们有机会清理资源（如定时器、事件监听器等）
   */
  public dispose(): void {
    this.webviewMessageDisposable?.dispose();
    this.webviewMessageDisposable = undefined;
    this.view = undefined;
    this.currentMethods = [];
    this.currentFields = [];
    this.currentEnumConstants = [];
    this.lastHighlightId = null;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.symbolRetryToken = null;
  }

  /**
   * cn - 更新高亮状态
   * en - update highlight state
   *
   * 优先搜索方法（有 endLine 可精确判断），其次搜索字段/枚举常量。
   * @param cursorLine - 光标所在行
   */
  private updateHighlight(cursorLine: LineNumber): void {
    // 1. 优先搜索方法（有 startLine/endLine 精确区间）
    const method = binarySearchMethod(this.currentMethods, cursorLine);
    if (method) {
      const newId = method.id as unknown as string;
      if (newId !== this.lastHighlightId) {
        this.lastHighlightId = newId;
        this.postMessage({
          type: "highlightMethod",
          payload: { id: method.id },
        });
      }
      return;
    }

    // 2. 搜索字段/枚举常量（无 endLine，用"下一个成员 startLine"作为上界）
    const fieldLine = this.findMemberStartLine(cursorLine);
    if (fieldLine !== null) {
      const lineKey = `field:${fieldLine}`;
      if (lineKey !== this.lastHighlightId) {
        this.lastHighlightId = lineKey;
        this.postMessage({
          type: "highlightField",
          payload: { line: LineNumber(fieldLine) },
        });
      }
      return;
    }

    // 3. 光标在方法间隙（注释区）→ 高亮下一个方法
    // 当光标位于两个方法之间（上一个方法已结束、下一个方法尚未开始），
    // 通常是在写下下一个方法的 Javadoc/JSDoc 注释，应高亮下一个方法。
    const nextMethod = this.findNextMethodInCommentGap(cursorLine);
    if (nextMethod) {
      const newId = nextMethod.id as unknown as string;
      if (newId !== this.lastHighlightId) {
        this.lastHighlightId = newId;
        this.postMessage({
          type: "highlightMethod",
          payload: { id: nextMethod.id },
        });
      }
      return;
    }

    // 4. 光标在字段间隙（注释区）→ 高亮下一个字段
    const nextFieldLine = this.findNextFieldInCommentGap(cursorLine);
    if (nextFieldLine !== null) {
      const lineKey = `field:${nextFieldLine}`;
      if (lineKey !== this.lastHighlightId) {
        this.lastHighlightId = lineKey;
        this.postMessage({
          type: "highlightField",
          payload: { line: LineNumber(nextFieldLine) },
        });
      }
      return;
    }

    // 5. 无匹配 — 清除高亮
    if (this.lastHighlightId !== null) {
      this.lastHighlightId = null;
      this.postMessage({ type: "clearHighlight" });
    }
  }

  /**
   * 查找光标所在注释区对应的方法。
   *
   * 当光标在方法 A（endLine）和方法 B（startLine）之间的间隙时，
   * 如果方法 B 有注释且间隙不太大，认为光标在 B 的注释区。
   *
   * @param cursorLine - 光标所在行
   * @returns 下一个方法，或 null
   */
  private findNextMethodInCommentGap(
    cursorLine: LineNumber,
  ): MethodDoc | null {
    for (const method of this.currentMethods) {
      if (method.startLine > cursorLine) {
        // 仅当方法有注释且光标在注释区范围内（间距 ≤ 30 行）时才高亮
        if (method.hasComment && method.startLine - cursorLine <= 30) {
          // 排除：光标和该方法之间有字段（光标可能在字段附近而非方法注释区）
          for (const field of this.currentFields) {
            if (field.startLine > cursorLine && field.startLine < method.startLine) {
              return null;
            }
          }
          for (const ec of this.currentEnumConstants) {
            if (ec.startLine > cursorLine && ec.startLine < method.startLine) {
              return null;
            }
          }
          return method;
        }
        return null;
      }
    }
    return null;
  }

  /**
   * 查找光标所在注释区对应的字段/枚举常量。
   *
   * 当光标在字段 A 和字段 B 之间的间隙时，
   * 如果字段 B 有注释且间隙不太大，认为光标在 B 的注释区。
   *
   * @param cursorLine - 光标所在行
   * @returns 下一个字段的 startLine，或 null
   */
  private findNextFieldInCommentGap(
    cursorLine: LineNumber,
  ): number | null {
    // 收集所有 startLine > cursorLine 的字段和枚举常量
    const candidates: Array<{ startLine: number; hasComment: boolean }> = [];
    for (const field of this.currentFields) {
      if (field.startLine > cursorLine) {
        candidates.push({ startLine: field.startLine, hasComment: field.hasComment });
      }
    }
    for (const ec of this.currentEnumConstants) {
      if (ec.startLine > cursorLine) {
        candidates.push({ startLine: ec.startLine, hasComment: ec.hasComment });
      }
    }

    // 按 startLine 升序，找第一个有注释且在 30 行内的
    candidates.sort((a, b) => a.startLine - b.startLine);
    for (const candidate of candidates) {
      const dist = candidate.startLine - cursorLine;
      if (dist > 30) break;
      if (candidate.hasComment) {
        // 排除：光标和该字段之间有方法（光标可能在方法注释区）
        for (const method of this.currentMethods) {
          if (method.startLine > cursorLine && method.startLine < candidate.startLine) {
            return null;
          }
        }
        return candidate.startLine;
      }
      // 下一个成员无注释，不再继续查找
      break;
    }
    return null;
  }

  /**
   * 在字段 + 枚举常量中查找光标所在行对应的 startLine。
   * 仅当光标不在任何方法区间内时才调用。
   *
   * 算法：找 startLine <= cursorLine 的最大值，
   * 且 cursorLine < 下一个成员（含方法）的 startLine。
   */
  private findMemberStartLine(cursorLine: LineNumber): number | null {
    let bestLine: number | null = null;

    for (const field of this.currentFields) {
      if (field.startLine <= cursorLine) {
        if (bestLine === null || field.startLine > bestLine) {
          bestLine = field.startLine;
        }
      }
    }
    for (const ec of this.currentEnumConstants) {
      if (ec.startLine <= cursorLine) {
        if (bestLine === null || ec.startLine > bestLine) {
          bestLine = ec.startLine;
        }
      }
    }

    if (bestLine === null) return null;

    // 确保光标不在 bestLine 之后的某个方法内
    // （如果有方法的 startLine > bestLine 且 <= cursorLine，说明光标在方法内，不应高亮字段）
    for (const method of this.currentMethods) {
      if (method.startLine > bestLine && method.startLine <= cursorLine) {
        return null;
      }
    }

    // 如果光标已远离当前字段声明（> 1 行），检查是否在下一个成员的注释区
    // 注释区：下一个有注释的成员（方法/字段/枚举）的 startLine 前 30 行内
    if (cursorLine - bestLine > 1) {
      for (const method of this.currentMethods) {
        if (
          method.startLine > cursorLine &&
          method.hasComment &&
          method.startLine - cursorLine <= 30
        ) {
          return null;
        }
      }
      for (const field of this.currentFields) {
        if (
          field.startLine > cursorLine &&
          field.hasComment &&
          field.startLine - cursorLine <= 30
        ) {
          return null;
        }
      }
      for (const ec of this.currentEnumConstants) {
        if (
          ec.startLine > cursorLine &&
          ec.hasComment &&
          ec.startLine - cursorLine <= 30
        ) {
          return null;
        }
      }
    }

    return bestLine;
  }

  /**
   * cn - 处理 Webview 发来的消息
   * en - handle messages from Webview
   * @param message - 原始消息（类型未知）
   */
  private handleUpstreamMessage(message: unknown): void {
    if (!isUpstreamMessage(message)) {
      console.warn("[JavaDocSidebar] Invalid upstream message:", message);
      return;
    }

    switch (message.type) {
      case "jumpToLine":
        this.jumpToLine(message.payload.line);
        break;

      case "openMarkdownLink":
        void this.openMarkdownLink(message.payload.href);
        break;

      case "webviewReady":
        void this.refresh();
        break;
    }
  }

  /**
   * 跳转到指定行
   *
   * @param line - 目标行号
   */
  private jumpToLine(line: LineNumber): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    const position = new vscode.Position(line, 0);
    const range = new vscode.Range(position, position);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  }

  /**
   * 打开 Markdown 本地链接
   *
   * 解析 href 并打开对应文件，支持以下形式：
   *   - ./Other.java、../other/Util.ts（相对当前文件目录）
   *   - Other.java#L10（带行号，1-based，自动转为 0-based）
   *   - 纯锚点 #section 不处理（webview 内无对应目标）
   *
   * 外部链接（http/https/mailto 等）不会走到此方法，由前端直接放行。
   *
   * @param href - 原始链接地址
   */
  private async openMarkdownLink(href: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    let filePath = href;
    let line: number | null = null;

    // 分离行号锚点：xxx#L10 → filePath=xxx, line=10
    const lineMatch = filePath.match(/^(.+?)#L(\d+)$/);
    if (lineMatch) {
      filePath = lineMatch[1] as string;
      line = Number.parseInt(lineMatch[2] as string, 10) - 1;
    }

    // 纯锚点（#section）无法定位，忽略
    if (filePath.startsWith("#")) {
      return;
    }

    const currentDir = path.dirname(editor.document.uri.fsPath);
    const targetPath = path.resolve(currentDir, filePath);

    try {
      const doc = await vscode.workspace.openTextDocument(targetPath);
      const targetEditor = await vscode.window.showTextDocument(doc);
      if (line !== null && line >= 0) {
        const position = new vscode.Position(line, 0);
        const range = new vscode.Range(position, position);
        targetEditor.selection = new vscode.Selection(position, position);
        targetEditor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      }
    } catch {
      void vscode.window.showWarningMessage(
        `无法打开链接: ${href}`,
      );
    }
  }

  /**
   * 向 Webview 发送消息
   *
   * @param message - 要发送的消息
   *
   * 【void 操作符】
   * postMessage 返回 Thenable（类似 Promise）
   * 我们不关心它的结果，用 void 表示忽略返回值
   */
  private postMessage(message: DownstreamMessage): void {
    void this.view?.webview.postMessage(message);
  }

  /**
   * 配置 Webview（设置 HTML 内容和安全选项）
   * @param webview webview 实例
   */
  private configureWebview(webview: vscode.Webview): void {
    this.updateWebviewOptions();
    webview.html = this.getHtmlContent(webview);
  }

  /**
   * Purpose: Keep local resource roots aligned with current document context.
   * Why: Markdown images can live in workspace folders or sibling directories.
   * @param document - Optional active markdown document for per-file roots.
   * Side effects: Updates webview security options in place.
   */
  private updateWebviewOptions(document?: TextDocument): void {
    const webview = this.view?.webview;
    if (!webview) {
      return;
    }

    const roots = this.getDefaultResourceRoots();
    if (document?.uri.scheme === "file") {
      roots.push(vscode.Uri.file(path.dirname(document.uri.fsPath)));
    }

    webview.options = {
      enableScripts: true,
      localResourceRoots: this.uniqueResourceRoots(roots),
    };
  }

  private getDefaultResourceRoots(): vscode.Uri[] {
    const roots: vscode.Uri[] = [vscode.Uri.joinPath(this.extensionUri, "media")];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      roots.push(folder.uri);
    }
    return roots;
  }

  private uniqueResourceRoots(roots: readonly vscode.Uri[]): vscode.Uri[] {
    const unique = new Map<string, vscode.Uri>();
    for (const uri of roots) {
      unique.set(uri.toString(), uri);
    }
    return Array.from(unique.values());
  }

  /**
   * Purpose: Resolve markdown image references to webview-safe URLs.
   * Why: Webview cannot load raw filesystem paths directly.
   * @param document - Source markdown document.
   * @param content - Markdown raw text.
   * @returns Map from markdown image source to transformed webview URL.
   */
  private buildMarkdownImageMap(
    document: TextDocument,
    content: string,
  ): Readonly<Record<string, string>> {
    const webview = this.view?.webview;
    if (!webview || document.uri.scheme !== "file") {
      return {};
    }

    const imageMap: Record<string, string> = {};
    const sources = this.extractMarkdownImageSources(content);
    for (const source of sources) {
      const fileUri = this.resolveMarkdownImageFileUri(document, source);
      if (!fileUri) {
        continue;
      }
      imageMap[source] = webview.asWebviewUri(fileUri).toString();
    }
    return imageMap;
  }

  private extractMarkdownImageSources(content: string): readonly string[] {
    const sources = new Set<string>();
    const matches = content.matchAll(MARKDOWN_IMAGE_PATTERN);
    for (const match of matches) {
      const rawTarget = match[1];
      if (!rawTarget) {
        continue;
      }
      const source = this.normalizeMarkdownImageTarget(rawTarget);
      if (!source || this.isExternalMarkdownImage(source)) {
        continue;
      }
      sources.add(source);
    }
    return Array.from(sources);
  }

  private normalizeMarkdownImageTarget(rawTarget: string): string | null {
    const trimmed = rawTarget.trim();
    if (!trimmed) {
      return null;
    }

    if (trimmed.startsWith("<")) {
      const end = trimmed.indexOf(">");
      if (end > 1) {
        return trimmed.slice(1, end).trim();
      }
    }

    const source = trimmed.split(/\s+/, 1)[0] ?? "";
    if (!source) {
      return null;
    }
    if (
      (source.startsWith(`"`) && source.endsWith(`"`)) ||
      (source.startsWith(`'`) && source.endsWith(`'`))
    ) {
      return source.slice(1, -1);
    }
    return source;
  }

  private isExternalMarkdownImage(source: string): boolean {
    return source.startsWith("#") || URI_SCHEME_PATTERN.test(source);
  }

  private resolveMarkdownImageFileUri(
    document: TextDocument,
    source: string,
  ): vscode.Uri | undefined {
    const sourcePath = this.decodeIfEncoded(source);
    if (!sourcePath) {
      return undefined;
    }

    if (WINDOWS_ABSOLUTE_PATH_PATTERN.test(sourcePath) || path.isAbsolute(sourcePath)) {
      return vscode.Uri.file(path.normalize(sourcePath));
    }

    if (sourcePath.startsWith("/")) {
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
      if (!workspaceFolder) {
        return undefined;
      }
      return vscode.Uri.file(
        path.join(workspaceFolder.uri.fsPath, sourcePath.slice(1)),
      );
    }

    return vscode.Uri.file(
      path.resolve(path.dirname(document.uri.fsPath), sourcePath),
    );
  }

  private decodeIfEncoded(value: string): string {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  /**
   * 注册 Webview 消息监听器
   * @param webview webview 实例
   */
  private registerWebviewMessageListener(webview: vscode.Webview): void {
    this.webviewMessageDisposable?.dispose();
    this.webviewMessageDisposable = webview.onDidReceiveMessage(
      (message: unknown) => {
        this.handleUpstreamMessage(message);
      },
    );
  }

  /**
   * 获取目标 Java 文档
   * @param document - 可选的文本文档
   * @returns 符合条件的 Java 文档，或 undefined
   */
  private getTargetSupportDocument(
    document?: TextDocument,
  ): TextDocument | undefined {
    const candidate = document ?? vscode.window.activeTextEditor?.document;
    if (!candidate || !isSupportedLanguage(candidate.languageId)) {
      return undefined;
    }
    return candidate;
  }

  /**
   * 生成 Webview 的 HTML 内容
   *
   * @param webview - Webview 实例
   *
   * 【为什么不直接读取 HTML 文件？】
   * 1. Webview 中的资源 URL 需要特殊处理（asWebviewUri）
   * 2. 需要动态生成 nonce（安全机制）
   * 3. 需要设置 Content-Security-Policy
   */
  private getHtmlContent(webview: vscode.Webview): string {
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "sidebar.css"),
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "sidebar.js"),
    );

    const nonce = this.getNonce();

    return /* html */ `
      <!DOCTYPE html>
      <html lang="zh-CN">
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy"
              content="default-src 'none'; img-src ${webview.cspSource} https: http: data:; style-src ${webview.cspSource} 'unsafe-inline' https://cdn.jsdelivr.net; font-src https://cdn.jsdelivr.net; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net;">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <link href="${styleUri.toString()}" rel="stylesheet">
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11/styles/vs2015.min.css">
        <title>JavaDoc Sidebar</title>
      </head>
      <body>
        <div id="sticky-header">
          <div class="sticky-title" id="sticky-title"></div>
          <div class="sticky-actions">
            <button class="view-toggle" id="viewToggle" title="切换视图模式"></button>
            <button class="lock-btn" id="lock-btn" title="锁定当前视图"></button>
          </div>
        </div>
        <div id="root"></div>
        <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
        <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>
        <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js"
                onload="if(window.__renderMath){window.__renderMath();}"></script>
        <script defer src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"
                onload="if(window.__initMermaid){window.__initMermaid();}"></script>
        <script defer src="https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11/highlight.min.js"
                onload="if(window.__highlightCode){window.__highlightCode();}"></script>
      </body>
      </html>
    `;
  }

  /**
   * 生成随机 nonce
   *
   * 【什么是 nonce？】
   * 一次性使用的随机字符串，用于防止 XSS 攻击
   * 只有带有正确 nonce 的 script 标签才会被执行
   */
  private getNonce(): string {
    return crypto.randomBytes(16).toString("hex");
  }
}
