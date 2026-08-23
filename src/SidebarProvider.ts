/**
 * SidebarProvider.ts - Webview 侧边栏管理器
 *
 * **这是整个扩展的核心模块**
 *
 * 职责：
 * 1. 管理 Webview 的生命周期（创建、销毁）
 * 2. 协调解析器和前端的通信
 * 3. 处理双向联动逻辑
 *
 * **WebviewViewProvider 是什么？：**
 * VS Code 提供的接口，用于创建侧边栏中的 Webview
 * 实现这个接口，VS Code 就知道如何显示你的侧边栏
 *
 * @author xiaowu
 * @since 2026/02/04
 */

import * as vscode from "vscode";
import * as path from "path";
import * as crypto from "crypto";
import * as fs from "fs";
import type {
  WebviewView,
  WebviewViewProvider,
  WebviewViewResolveContext,
  CancellationToken,
  TextDocument,
  Disposable,
} from "vscode";
import { DocCommentParser } from "./parser/DocCommentParser.js";
import { resolveSymbols } from "./parser/SymbolResolver.js";
import { debounce } from "./utils/debounce.js";
import { throttle } from "./utils/throttle.js";
import { binarySearchMethod } from "./utils/binarySearch.js";
import type {
  MethodDoc,
  FieldDoc,
  EnumConstantDoc,
  DownstreamMessage,
} from "./types.js";
import { isSupportedLanguage, isUpstreamMessage, LineNumber } from "./types.js";

const HIGHLIGHT_DEBOUNCE_DELAY = 300;
/** 文档编辑后刷新侧边栏的防抖延迟（毫秒） */
const DOCUMENT_CHANGE_DEBOUNCE_DELAY = 300;
/**
 * 编辑器滚动 → 侧边栏同步的节流间隔（毫秒）。
 *
 * 与 webview 反向同步的 SIDEBAR_SCROLL_THROTTLE_MS=30 对称；
 * visibleRanges 事件每帧（约 16ms）到达一次，30ms 节流约 33 次/秒，
 * 配合 webview 端 RAF 缓动足够平滑。
 */
const SCROLL_SYNC_THROTTLE_MS = 30;
/**
 * 侧边栏发起跳转/滚动后的"编辑器滚动回传抑制窗口"时长（毫秒）。
 *
 * 点击卡片（jumpToLine）或侧边栏滚动（scrollEditor）会让编辑器滚动，
 * 其 visibleRanges 变化会经 throttledScrollSync 回传 syncScroll，把
 * 侧边栏弹回原地。revealRange 在 editor.smoothScrolling 下是平滑动画，
 * 会产生多次连续事件，单次消费标志会漏过后继事件——因此用"时间窗口 +
 * 事件续期"抑制：窗口内每次收到可见范围变化都续期，直到编辑器滚动真正
 * 停止，期间所有回传一律丢弃，窗口过期后恢复同步。
 */
const SCROLL_ECHO_SUPPRESS_MS = 400;
/**
 * 抑制窗口"事件续期"的总时长上限（毫秒）。
 *
 * 续期本意是覆盖平滑滚动动画全程；但窗口内的事件无法区分"动画回传"与
 * "用户主动滚动"——若用户点击跳转后立即滚动编辑器，旧实现会把抑制无限
 * 延长（滚多久冻多久），侧边栏直到用户停滚才恢复跟随。此上限约束续期
 * 最晚截止时间：超过后不再续期，窗口自然过期恢复同步（用户滚动最多被
 * 抑制约 1.4s）。
 */
const SCROLL_ECHO_SUPPRESS_MAX_MS = 1000;
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
 * 持久化用户视图模式偏好（简洁/详细）的 globalState 键。
 * 值为 "compact" | "detail"，跨会话记忆用户选择。
 */
const VIEW_MODE_STORAGE_KEY = "commentSidebar.viewMode";

/**
 * 可选代码高亮主题：设置值 → media/vendor 下的样式文件名。
 *
 * 所有主题全部预加载进 webview（disabled），由
 * body[data-hljs-dark / data-hljs-light]（来自设置）+ 编辑器明暗类
 * （vscode-light / vscode-dark）决定启用哪一套。
 */
const CODE_HIGHLIGHT_THEMES: Readonly<Record<string, string>> = {
  "vs2015": "vs2015.min.css",
  "github": "github.min.css",
  "catppuccin-latte": "catppuccin-latte.css",
  "catppuccin-frappe": "catppuccin-frappe.css",
  "catppuccin-macchiato": "catppuccin-macchiato.css",
  "catppuccin-mocha": "catppuccin-mocha.css",
};
/** 未配置或配置值无效时的回退主题 */
const CODE_HIGHLIGHT_THEME_DEFAULTS: Readonly<{
  dark: string;
  light: string;
}> = { dark: "vs2015", light: "github" };

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
  private readonly parser: DocCommentParser;
  private readonly debouncedHighlight: (line: number) => void;
  /** 文档编辑后防抖刷新（边写边同步） */
  private readonly debouncedRefresh: (document: TextDocument) => void;
  private webviewMessageDisposable: Disposable | undefined;
  /** 配置变更监听（代码高亮主题设置变化时通知 webview 切换主题） */
  private configListener: Disposable | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private symbolRetryToken: { uri: string; version: number } | null = null;
  private throttledScrollSync: (
    topLine: number,
    bottomLine: number,
    totalLines: number,
    centerLine?: number,
  ) => void;
  /** 编辑器滚动回传抑制窗口的截止时间戳（Date.now()，0 表示无抑制） */
  private scrollEchoSuppressUntil = 0;
  /** 抑制续期的最晚时间戳：超过后窗口内事件不再续期（防止用户滚动被无限抑制） */
  private scrollEchoSuppressDeadline = 0;

  /**
   * 构造函数
   *
   * @param context - 扩展上下文，提供 extensionUri（加载 webview 资源）与
   * globalState（持久化用户视图模式偏好）
   */
  constructor(private readonly context: vscode.ExtensionContext) {
    this.parser = new DocCommentParser();
    this.debouncedHighlight = debounce((line: number) => {
      this.updateHighlight(LineNumber(line));
    }, HIGHLIGHT_DEBOUNCE_DELAY);

    // 边写边同步：文档编辑后防抖刷新侧边栏，刷新完成后重新高亮当前光标位置
    this.debouncedRefresh = debounce(async (document: TextDocument) => {
      await this.refresh(document);
      // 刷新会重置 lastHighlightId，需重新触发当前光标位置的高亮
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document === document) {
        const line = editor.selection.active.line;
        this.updateHighlight(LineNumber(line));
      }
    }, DOCUMENT_CHANGE_DEBOUNCE_DELAY);
    // 编辑器滚动 → 侧边栏同步必须用节流而非防抖：visibleRanges 事件在滚动
    // 期间持续高频到达（每帧一次），防抖（旧实现 50ms）会把同步推迟到
    // "滚动停止后"才执行——滚动过程中侧边栏纹丝不动、停手后才猛地跳到位，
    // 即"不跟手"的直接原因。节流保证滚动期间每 SCROLL_SYNC_THROTTLE_MS
    // 至少同步一次，trailing 兜底保证停手后最终位置精确归位。
    this.throttledScrollSync = throttle((
      topLine: number,
      bottomLine: number,
      totalLines: number,
      centerLine?: number,
    ) => {
      // 侧边栏发起跳转/滚动后的编辑器滚动回传：抑制窗口内一律不回传
      // （防止反馈循环）。窗口由时间戳控制，到期自然恢复，无需显式复位。
      if (Date.now() < this.scrollEchoSuppressUntil) {
        return;
      }
      this.postMessage({
        type: "syncScroll",
        payload: {
          topLine,
          bottomLine,
          totalLines,
          // 视觉中心行（小数行号，折行时按字符偏移中点精确计算）；
          // 未提供时回退为逻辑行中位数，兼容旧调用方
          centerLine:
            typeof centerLine === "number" ? centerLine : (topLine + bottomLine) / 2,
        },
      });
    }, SCROLL_SYNC_THROTTLE_MS);

    // 设置变更：深/浅色默认代码高亮主题切换时，实时通知 webview 换主题
    this.configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("commentSidebar.codePreviewTheme")) {
        this.postMessage({
          type: "setHighlightTheme",
          payload: {
            dark: this.getHighlightThemeSetting("dark"),
            light: this.getHighlightThemeSetting("light"),
          },
        });
      }
    });
  }
  /**
   * 解析 Webview（由 VS Code 调用）
   *
   * 用户第一次点击侧边栏图标时，VS Code 会调用这个方法，
   * 让我们有机会配置和初始化 Webview。
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
      console.error("[CommentSidebar] resolveWebviewView failed:", error);
    }
  }

  /**
   * 刷新侧边栏内容
   *
   * @param document - 要解析的文档，不传则使用当前活动文档
   *
   * **async/await 解释：**
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
      console.error("[CommentSidebar] Parse error:", error);
    }
  }

  /**
   * 临时调试方法：收集 LSP 符号与解析结果，发送到 webview 调试面板展示。
   */
  public async debugDump(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage("没有打开的文件");
      return;
    }
    const document = editor.document;
    const lines: string[] = [];

    // LSP 符号
    const symbols = await resolveSymbols(document.uri);
    lines.push(`=== LSP Symbols (${symbols.length} top-level) ===`);
    const dumpSymbol = (s: vscode.DocumentSymbol, indent: string): void => {
      lines.push(
        `${indent}name=${s.name} kind=${s.kind} ` +
          `range=${s.range.start.line}-${s.range.end.line} ` +
          `selRange=${s.selectionRange.start.line}-${s.selectionRange.end.line} ` +
          `detail=${s.detail || "(none)"} children=${s.children.length}`,
      );
      for (const c of s.children) {
        dumpSymbol(c, indent + "  ");
      }
    };
    for (const s of symbols) {
      dumpSymbol(s, "");
    }

    // 解析结果
    const doc = await this.parser.parse(document);
    lines.push(`\n=== Parsed Result ===`);
    lines.push(`classComment=${JSON.stringify(doc.classComment)}`);
    lines.push(`fileHeaderStartLine=${doc.fileHeaderStartLine}`);
    lines.push(`fileHeaderEndLine=${doc.fileHeaderEndLine}`);
    lines.push(`\n--- Fields (${doc.fields.length}) ---`);
    for (const f of doc.fields) {
      lines.push(
        `  name=${f.name} startLine=${f.startLine} hasComment=${f.hasComment} ` +
          `comment=${JSON.stringify(f.description)}`,
      );
    }
    lines.push(`\n--- Methods (${doc.methods.length}) ---`);
    for (const m of doc.methods) {
      lines.push(
        `  name=${m.name} startLine=${m.startLine} hasComment=${m.hasComment} ` +
          `comment=${JSON.stringify(m.description)}`,
      );
    }
    lines.push(`\n--- TypeGroups (${doc.typeGroups.length}) ---`);
    for (const g of doc.typeGroups) {
      lines.push(
        `  typeName=${g.typeName} startLine=${g.startLine} ` +
          `comment=${JSON.stringify(g.comment)}`,
      );
    }
    lines.push(`\n--- EnumConstants (${doc.enumConstants.length}) ---`);
    for (const e of doc.enumConstants) {
      lines.push(
        `  name=${e.name} startLine=${e.startLine} hasComment=${e.hasComment}`,
      );
    }

    this.postMessage({
      type: "debugInfo",
      payload: { content: lines.join("\n") },
    });
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
   * 处理光标选择变化（从 extension.ts 调用）
   * @param line - 光标所在行号
   */
  public handleSelectionChange(line: number): void {
    this.debouncedHighlight(line);
  }

  /**
   * 处理文档内容编辑事件（边写边同步）
   *
   * 由 extension.ts 的 onDidChangeTextDocument 监听器调用，
   * 防抖 300ms 后重新解析文档并更新侧边栏，刷新完成后重新高亮当前光标位置。
   *
   * @param document - 发生变更的文档
   */
  public onDocumentChanged(document: TextDocument): void {
    this.debouncedRefresh(document);
  }

  /**
   * 处理编辑器可见区域变化（滚动同步）
   *
   * 将可见区域行号发送给 webview，webview 线性映射到卡片位置进行同步滚动。
   * 不切换聚焦 —— 聚焦仅由光标位置变化驱动。
   *
   * @param topLine - 可见区域顶部行号（折行时含行内比例的小数行号）
   * @param bottomLine - 可见区域底部行号（折行时含行内比例的小数行号）
   * @param totalLines - 文档总行数
   * @param centerLine - 视觉中心对应的小数行号（折行时按字符偏移中点计算，
   *   比 (topLine + bottomLine) / 2 精确）
   */
  public handleVisibleRangeChange(
    topLine: number,
    bottomLine: number,
    totalLines: number,
    centerLine?: number,
  ): void {
    // 抑制窗口内收到可见范围变化（平滑滚动会产生连续事件）则续期窗口，
    // 使抑制覆盖整个跳转引发的滚动过程，直到编辑器滚动真正停止。
    // 续期受 deadline 上限约束：超过上限（说明用户已介入滚动，事件流
    // 不再是跳转动画）后不再续期，窗口自然过期恢复同步——避免"点击跳转
    // 后用户滚动编辑器"时抑制被事件无限延长、侧边栏永不跟随。
    if (
      Date.now() < this.scrollEchoSuppressUntil &&
      Date.now() < this.scrollEchoSuppressDeadline
    ) {
      this.scrollEchoSuppressUntil = Date.now() + SCROLL_ECHO_SUPPRESS_MS;
    }
    this.throttledScrollSync(topLine, bottomLine, totalLines, centerLine);
  }

  /**
   * 滚动编辑器到指定行（不移动光标）
   *
   * 由侧边栏滚动触发，线性映射到源码行后调用。
   * 以"中间对齐"为基准：目标行落在编辑器视口中间而非顶部，
   * 与侧边栏"可视区域中间为基准"的反向映射严格对称。
   *
   * 支持小数行号：自动折行下长逻辑行占多屏，若只 reveal 到行首，
   * 视觉中心会被钉在行首；小数行号按行内字符比例换算成字符偏移，
   * 使编辑器精确居中到侧边栏视觉中心对应的字符位置。
   *
   * @param line - 目标行号（可为小数）
   */
  private scrollEditorToLine(line: number): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const whole = Math.floor(line);
    const frac = Math.max(0, Math.min(1, line - whole));
    const lineCount = editor.document.lineCount;
    if (whole >= lineCount) {
      // 行号超出文档末尾（末行锚点之后），退化到文档末尾
      const eof = new vscode.Position(lineCount, 0);
      const eofRange = new vscode.Range(eof, eof);
      editor.revealRange(eofRange, vscode.TextEditorRevealType.InCenter);
      return;
    }
    const textLine = editor.document.lineAt(whole);
    const char = Math.round(frac * textLine.text.length);
    const position = new vscode.Position(whole, char);
    const range = new vscode.Range(position, position);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  }

  /**
   * 释放资源（Disposable 接口）
   *
   * **何时被调用？：**
   * 扩展被禁用或卸载时，VS Code 会调用这个方法
   * 让我们有机会清理资源（如定时器、事件监听器等）
   */
  public dispose(): void {
    this.webviewMessageDisposable?.dispose();
    this.webviewMessageDisposable = undefined;
    this.configListener?.dispose();
    this.configListener = undefined;
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
   * 更新高亮状态
   *
   * 优先搜索方法（有 endLine 可精确判断），其次搜索字段/枚举常量。
   * @param cursorLine - 光标所在行
   */
  private updateHighlight(cursorLine: LineNumber): void {
    // 1. 优先搜索方法（有 startLine/endLine 精确区间）
    const method = binarySearchMethod(this.currentMethods, cursorLine);
    if (method) {
      const newId = method.id as unknown as string;
      // 不按 id 去重：光标在同一方法内不同位置移动时也重新定位侧边栏，
      // 使卡片跟随光标保持可见。发送频率由 debouncedHighlight(300ms) 控制，
      // 不会造成消息风暴。
      this.lastHighlightId = newId;
      this.postMessage({
        type: "highlightMethod",
        payload: { id: method.id },
      });
      return;
    }

    // 2. 搜索字段/枚举常量（无 endLine，用"下一个成员 startLine"作为上界）
    const fieldLine = this.findMemberStartLine(cursorLine);
    if (fieldLine !== null) {
      const lineKey = `field:${fieldLine}`;
      // 同上：同一字段内移动也重新定位
      this.lastHighlightId = lineKey;
      this.postMessage({
        type: "highlightField",
        payload: { line: LineNumber(fieldLine) },
      });
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
    // 一次遍历找 startLine > cursorLine 的最小候选（字段 + 枚举常量）
    // 等价于原 sort + 取首个，但无需构建数组与排序
    let bestStartLine = Infinity;
    let bestHasComment = false;
    for (const field of this.currentFields) {
      if (field.startLine > cursorLine && field.startLine < bestStartLine) {
        bestStartLine = field.startLine;
        bestHasComment = field.hasComment;
      }
    }
    for (const ec of this.currentEnumConstants) {
      if (ec.startLine > cursorLine && ec.startLine < bestStartLine) {
        bestStartLine = ec.startLine;
        bestHasComment = ec.hasComment;
      }
    }

    if (bestStartLine === Infinity) return null;
    if (bestStartLine - cursorLine > 30) return null;
    if (!bestHasComment) return null;

    // 排除：光标和该字段之间有方法（光标可能在方法注释区）
    for (const method of this.currentMethods) {
      if (method.startLine > cursorLine && method.startLine < bestStartLine) {
        return null;
      }
    }
    return bestStartLine;
  }

  /**
   * 查找光标所在字段/枚举常量的起始行。
   *
   * 算法：精确范围匹配 `startLine <= cursorLine <= endLine`，
   * 优先返回 startLine 最大的命中（声明行接近、范围重叠时错选避免）。
   *
   * @param cursorLine - 光标所在行
   * @returns 命中字段的 startLine，未命中返回 null
   */
  private findMemberStartLine(cursorLine: LineNumber): number | null {
    let bestLine: number | null = null;

    for (const field of this.currentFields) {
      if (field.startLine <= cursorLine && cursorLine <= field.endLine) {
        if (bestLine === null || field.startLine > bestLine) {
          bestLine = field.startLine;
        }
      }
    }
    for (const ec of this.currentEnumConstants) {
      if (ec.startLine <= cursorLine && cursorLine <= ec.endLine) {
        if (bestLine === null || ec.startLine > bestLine) {
          bestLine = ec.startLine;
        }
      }
    }

    // 防止误选：如果有方法声明落在 bestLine 之后且光标之前，
    // 说明光标实际在该方法内（方法应已在 updateHighlight 步骤1命中，此处兜底）
    if (bestLine !== null) {
      for (const method of this.currentMethods) {
        if (method.startLine > bestLine && method.startLine <= cursorLine) {
          return null;
        }
      }
    }

    return bestLine;
  }

  /**
   * 开启"编辑器滚动回传抑制"：侧边栏发起跳转/滚动时调用。
   *
   * 立即开启抑制窗口，并记录续期 deadline（取较晚值，多次触发不缩短
   * 前一次的覆盖范围）。窗口过期后由 handleVisibleRangeChange 的续期
   * 逻辑接管，直至 deadline 到期自然恢复同步。
   */
  private beginScrollEchoSuppression(): void {
    this.scrollEchoSuppressUntil = Date.now() + SCROLL_ECHO_SUPPRESS_MS;
    this.scrollEchoSuppressDeadline = Math.max(
      this.scrollEchoSuppressDeadline,
      Date.now() + SCROLL_ECHO_SUPPRESS_MAX_MS,
    );
  }

  /**
   * 处理 Webview 发来的消息
   * @param message - 原始消息（类型未知）
   */
  private handleUpstreamMessage(message: unknown): void {
    if (!isUpstreamMessage(message)) {
      console.warn("[CommentSidebar] Invalid upstream message:", message);
      return;
    }

    switch (message.type) {
      case "jumpToLine":
        // 侧边栏点击卡片发起的跳转：编辑器滚动是跳转结果而非用户主动滚动，
        // 开启回传抑制窗口，避免 visibleRanges 变化经 throttledScrollSync
        // 把刚拖走的侧边栏弹回卡片位置（与 scrollEditor 同一机制）。
        // 目标行已在视口内时无可见范围变化，窗口自然过期，不影响后续同步。
        this.beginScrollEchoSuppression();
        this.jumpToLine(message.payload.line);
        break;

      case "openMarkdownLink":
        void this.openMarkdownLink(message.payload.href);
        break;

      case "navigateToSymbol":
        void this.navigateToSymbol(message.payload.name);
        break;

      case "scrollEditor":
        // 侧边栏滚动触发的编辑器滚动：开启回传抑制窗口，防止编辑器
        // 滚动把侧边栏拉回原地形成反馈循环（与 jumpToLine 同一机制）
        this.beginScrollEchoSuppression();
        this.scrollEditorToLine(message.payload.line);
        break;

      case "webviewReady":
        void this.refresh();
        break;

      case "setViewMode":
        void this.setViewMode(message.payload.mode);
        break;

      case "__debug":
        // #region debug-point X:forward
        // 调试插桩转发：webview 事件转发至本地调试服务器（仅调试会话期间存在）
        this.forwardDebugEvent(message.payload);
        // #endregion
        break;
    }
  }

  // #region debug-point X:forward
  /**
   * 调试插桩转发（仅调试会话期间存在）：webview 无法直连调试服务器
   * （CSP default-src 'none'），日志经扩展宿主打印到 F5 调试面板的
   * Debug Console；同时尝试转发本地调试服务器（可用则留档 ndjson）。
   */
  private forwardDebugEvent(payload: { hyp: string; loc: string; msg: string; data?: unknown }): void {
    try {
      const tag = "[CS-DEBUG]";
      const dataStr = payload.data === undefined ? "" : " data=" + JSON.stringify(payload.data);
      console.log(tag, "hyp=" + payload.hyp, "loc=" + payload.loc, "msg=" + payload.msg + dataStr);
      if (payload.hyp === "D" || payload.hyp === "E") {
        // 错误类事件额外用 console.error 便于在 Debug Console 定位崩溃现场
        console.error(tag, "hyp=" + payload.hyp, "loc=" + payload.loc, "msg=" + payload.msg + dataStr);
      }
      const envPath = path.join(__dirname, "..", ".dbg", "mermaid-dark-crash.env");
      let url = "http://127.0.0.1:7777/event";
      if (fs.existsSync(envPath)) {
        const env = fs.readFileSync(envPath, "utf8");
        const m = /DEBUG_SERVER_URL=(\S+)/.exec(env);
        const found = m ? m[1] : undefined;
        if (found) url = found;
      }
      const body = JSON.stringify({
        sessionId: "mermaid-dark-crash",
        runId: "pre-fix",
        hypothesisId: payload.hyp,
        location: payload.loc,
        msg: "[DEBUG] " + payload.msg,
        data: payload.data ?? {},
        ts: Date.now(),
      });
      // 扩展宿主运行于 Node 18+，全局 fetch 可用；失败不影响业务
      (globalThis as { fetch?: (url: string, init?: unknown) => Promise<unknown> }).fetch?.(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      })?.catch(() => {});
    } catch (e) {
      // 调试上报失败不影响业务
    }
  }
  // #endregion

  /**
   * 读取持久化的视图模式偏好，缺省返回 "compact"（简洁模式）。
   */
  private getStoredViewMode(): "compact" | "detail" {
    return this.context.globalState.get<string>(VIEW_MODE_STORAGE_KEY) === "detail"
      ? "detail"
      : "compact";
  }

  /**
   * 持久化用户切换后的视图模式偏好（跨会话记忆）。
   *
   * @param mode - "compact" | "detail"，其他值忽略
   */
  private async setViewMode(mode: string): Promise<void> {
    if (mode !== "compact" && mode !== "detail") {
      return;
    }
    await this.context.globalState.update(VIEW_MODE_STORAGE_KEY, mode);
  }

  /**
   * 跳转到指定行
   *
   * 定位效果与"在编辑器中点击代码"一致：目标行已在可视区内时不滚动（仅移动
   * 光标），仅在不可见时才居中。原先用 InCenter 会强制居中，即使目标已可见也
   * 跳动，与点击代码的原生行为不一致。
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
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
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
   * 跳转到文件内指定符号
   *
   * 查找策略：
   * 1. 通过 DocumentSymbolProvider 精确查找
   * 2. 回退：在源码文本中搜索符号声明模式（class/method/const/function + name）
   *
   * @param name - 符号名称（如类型名、方法名、ClassName.methodName）
   */
  private async navigateToSymbol(name: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    // 策略 1：通过 DocumentSymbolProvider 查找
    try {
      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        editor.document.uri,
      );

      const target = this.findSymbolByName(symbols ?? [], name);
      if (target) {
        const pos = target.selectionRange.start;
        const range = new vscode.Range(pos, pos);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        return;
      }
    } catch {
      // DocumentSymbolProvider 不可用，继续回退
    }

    // 策略 2：在源码文本中搜索声明模式
    const text = editor.document.getText();
    const lines = text.split("\n");
    const lastPart = name.includes(".") ? name.split(".").pop() ?? name : name;

    // 匹配常见声明模式：class/method/function/const/let/var/def + name
    const patterns = [
      new RegExp(`\\bclass\\s+${this.escapeRegExp(lastPart)}\\b`),
      new RegExp(`\\binterface\\s+${this.escapeRegExp(lastPart)}\\b`),
      new RegExp(`\\benum\\s+${this.escapeRegExp(lastPart)}\\b`),
      new RegExp(`\\bfunction\\s+${this.escapeRegExp(lastPart)}\\b`),
      new RegExp(`\\b(?:const|let|var)\\s+${this.escapeRegExp(lastPart)}\\b`),
      new RegExp(`\\bdef\\s+${this.escapeRegExp(lastPart)}\\b`),
      new RegExp(`\\bpublic\\s+.*\\b${this.escapeRegExp(lastPart)}\\s*\\(`),
      new RegExp(`\\bprivate\\s+.*\\b${this.escapeRegExp(lastPart)}\\s*\\(`),
      new RegExp(`\\b${this.escapeRegExp(lastPart)}\\s*\\(`),
    ];

    for (const pattern of patterns) {
      for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i] ?? "")) {
          const pos = new vscode.Position(i, 0);
          const range = new vscode.Range(pos, pos);
          editor.selection = new vscode.Selection(pos, pos);
          editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
          return;
        }
      }
    }

    void vscode.window.showWarningMessage(`未找到符号: ${name}`);
  }

  /**
   * 在符号树中递归查找指定名称的符号
   */
  private findSymbolByName(
    symbols: readonly vscode.DocumentSymbol[],
    name: string,
  ): vscode.DocumentSymbol | null {
    for (const sym of symbols) {
      // 支持部分匹配（如 "Class.method"）
      if (sym.name === name || sym.name.endsWith(`.${name}`)) {
        return sym;
      }
      if (sym.children.length > 0) {
        const found = this.findSymbolByName(sym.children, name);
        if (found) {
          return found;
        }
      }
    }
    return null;
  }

  /**
   * 转义正则表达式特殊字符
   */
  private escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * 向 Webview 发送消息
   *
   * @param message - 要发送的消息
   *
   * **void 操作符：**
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
   * 让本地资源根目录与当前文档上下文保持一致。
   *
   * 设计原因：Markdown 图片可能位于 workspace 文件夹或同级目录中。
   *
   * @param document - 可选的活动 markdown 文档，用于按文件设置资源根。
   * 副作用：就地更新 webview 安全选项。
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
    const roots: vscode.Uri[] = [vscode.Uri.joinPath(this.context.extensionUri, "media")];
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
   * 将 markdown 图片引用解析为 webview 安全的 URL。
   *
   * 设计原因：Webview 无法直接加载原始文件系统路径。
   *
   * @param document - 源 markdown 文档。
   * @param content - Markdown 原始文本。
   * @returns 从 markdown 图片源到转换后 webview URL 的映射。
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
   * 读取深/浅色代码高亮主题设置，无效值回退默认。
   *
   * @param scope - "dark" | "light"，对应编辑器明暗
   */
  private getHighlightThemeSetting(scope: "dark" | "light"): string {
    const configured = vscode.workspace
      .getConfiguration("commentSidebar")
      .get<string>(`codePreviewTheme.${scope}`);
    return configured && configured in CODE_HIGHLIGHT_THEMES
      ? configured
      : CODE_HIGHLIGHT_THEME_DEFAULTS[scope];
  }

  /**
   * 生成 Webview 的 HTML 内容
   *
   * @param webview - Webview 实例
   *
   * **为什么不直接读取 HTML 文件？：**
   * 1. Webview 中的资源 URL 需要特殊处理（asWebviewUri）
   * 2. 需要动态生成 nonce（安全机制）
   * 3. 需要设置 Content-Security-Policy
   */
  private getHtmlContent(webview: vscode.Webview): string {
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "sidebar.css"),
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "sidebar.js"),
    );
    // 本地第三方资源（KaTeX / Mermaid / highlight.js），保证离线可用
    const vendorUri = (file: string) =>
      webview.asWebviewUri(
        vscode.Uri.joinPath(this.context.extensionUri, "media", "vendor", file),
      );

    const nonce = this.getNonce();
    // 代码高亮主题：全部预加载，由前端按设置 + 编辑器明暗启用对应一套
    const highlightLinks = Object.entries(CODE_HIGHLIGHT_THEMES)
      .map(
        ([name, file]) =>
          `<link id="hljs-${name}" href="${vendorUri(file).toString()}" rel="stylesheet" disabled>`,
      )
      .join("\n        ");

    return /* html */ `
      <!DOCTYPE html>
      <html lang="zh-CN">
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy"
              content="default-src 'none'; img-src ${webview.cspSource} https: http: data:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <link href="${styleUri.toString()}" rel="stylesheet">
        <link href="${vendorUri("katex.min.css").toString()}" rel="stylesheet">
        ${highlightLinks}
        <title>Comment Sidebar</title>
      </head>
      <body data-view-mode="${this.getStoredViewMode()}"
            data-hljs-dark="${this.getHighlightThemeSetting("dark")}"
            data-hljs-light="${this.getHighlightThemeSetting("light")}">
        <div id="sticky-header">
          <div class="sticky-title" id="sticky-title"></div>
          <div class="sticky-actions">
            <button class="view-toggle" id="viewToggle" title="切换视图模式"></button>
            <button class="lock-btn" id="lock-btn" title="锁定当前视图"></button>
          </div>
        </div>
        <div id="root"></div>
        <div id="debug-panel" class="debug-panel" style="display:none;">
          <div class="debug-panel-header">
            <span>Debug</span>
            <button id="debug-close" title="关闭">&times;</button>
          </div>
          <pre id="debug-content"></pre>
        </div>
        <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
        <script nonce="${nonce}" defer src="${vendorUri("katex.min.js").toString()}"
                onload="if(window.__renderMath){window.__renderMath();}"
                onerror="if(window.__vendorError){window.__vendorError('公式');}"></script>
        <script nonce="${nonce}" defer src="${vendorUri("auto-render.min.js").toString()}"
                onload="if(window.__renderMath){window.__renderMath();}"
                onerror="if(window.__vendorError){window.__vendorError('公式');}"></script>
        <script nonce="${nonce}" defer src="${vendorUri("mermaid.min.js").toString()}"
                onload="if(window.__initMermaid){window.__initMermaid();}"
                onerror="if(window.__vendorError){window.__vendorError('图表');}"></script>
        <script nonce="${nonce}" defer src="${vendorUri("highlight.min.js").toString()}"
                onload="if(window.__highlightCode){window.__highlightCode();}"
                onerror="if(window.__vendorError){window.__vendorError('代码高亮');}"></script>
      </body>
      </html>
    `;
  }

  /**
   * 生成随机 nonce
   *
   * **什么是 nonce？：**
   * 一次性使用的随机字符串，用于防止 XSS 攻击
   * 只有带有正确 nonce 的 script 标签才会被执行
   */
  private getNonce(): string {
    return crypto.randomBytes(16).toString("hex");
  }
}
