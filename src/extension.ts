/**
 * extension.ts - 扩展入口文件
 *
 * **VS Code 扩展的生命周期：**
 * 1. 用户触发激活事件（如打开 Java 文件）
 * 2. VS Code 调用 activate() 函数
 * 3. 扩展注册各种功能（命令、视图、事件监听等）
 * 4. 用户使用扩展...
 * 5. VS Code 关闭或扩展被禁用时，调用 deactivate()
 *
 * **本模块职责：**
 * 只做三件事：
 * 1. 注册 WebviewViewProvider（侧边栏）
 * 2. 注册事件监听器（文件保存、光标移动等）
 * 3. 注册命令（刷新按钮等）
 *
 * 不做任何业务逻辑！业务逻辑在 SidebarProvider 中
 *
 * @author xiaowu
 * @since 2026/02/04
 */

import * as vscode from "vscode";
import type { Disposable } from "vscode";
import { SidebarProvider } from "./SidebarProvider.js";
import {
  clearAllSymbolCache,
  clearSymbolCache,
} from "./parser/SymbolResolver.js";
import { isSupportedLanguage } from "./types.js";
/**
 * 扩展激活函数
 *
 * **ExtensionContext 的作用：**
 * 1. subscriptions：Disposable 数组，扩展卸载时自动清理
 * 2. extensionUri：扩展根目录的 URI
 * 3. globalState/workspaceState：持久化存储
 *
 * @param context - 扩展上下文，用于管理资源生命周期
 */
export function activate(context: vscode.ExtensionContext): void {
  console.log("[CommentSidebar] Extension is now active!");
  // 为侧边栏和面板注册 WebViewProvider
  const sidebarProvider = new SidebarProvider(context);
  // 创建左侧栏视图
  const viewProviderDisposable = vscode.window.registerWebviewViewProvider(
    "commentSidebar",
    sidebarProvider,
    {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    },
  );
  // 以下三个方法用于注册事件监听器

  const saveListener = createSaveListener(sidebarProvider);

  const documentChangeListener =
    createDocumentChangeListener(sidebarProvider);

  const editorChangeListener = createEditorChangeListener(sidebarProvider);

  const selectionListener = createSelectionListener(sidebarProvider);

  const visibleRangeListener = createVisibleRangeListener(sidebarProvider);

  const closeListener = createCloseListener();

  // 注册刷新命令

  const refreshCommand = vscode.commands.registerCommand(
    "commentSidebar.refresh",
    () => {
      void sidebarProvider.refresh();
    },
  );

  // 临时调试命令：输出当前文件的 LSP 符号和解析结果到侧边栏调试面板
  const debugDumpCommand = vscode.commands.registerCommand(
    "commentSidebar.debugDump",
    () => {
      void sidebarProvider.debugDump();
    },
  );

  // 注册到 subscriptions 以便自动释放
  context.subscriptions.push(
    viewProviderDisposable,
    saveListener,
    documentChangeListener,
    editorChangeListener,
    selectionListener,
    visibleRangeListener,
    closeListener,
    refreshCommand,
    debugDumpCommand,
    sidebarProvider,
  );
}

/**
 * 创建文件保存事件监听器
 */
function createSaveListener(provider: SidebarProvider): Disposable {
  return vscode.workspace.onDidSaveTextDocument((document) => {
    // TODO(xiaowu): 未来支持更多语言
    if (isSupportedLanguage(document.languageId)) {
      void provider.refresh(document);
    }
  });
}

/**
 * 创建文档编辑事件监听器（边写边同步）
 *
 * 用户输入时 onDidChangeTextDocument 频繁触发，通过清除符号缓存 +
 * 防抖 300ms 重新解析，实现侧边栏内容实时跟随编辑器更新。
 */
function createDocumentChangeListener(
  provider: SidebarProvider,
): Disposable {
  return vscode.workspace.onDidChangeTextDocument((event) => {
    const document = event.document;
    if (!isSupportedLanguage(document.languageId)) {
      return;
    }
    // 清除该文件的 LSP 符号缓存，确保下次解析拿到最新符号
    clearSymbolCache(document.uri);
    provider.onDocumentChanged(document);
  });
}

/**
 * 创建编辑器切换监听器
 */
function createEditorChangeListener(provider: SidebarProvider): Disposable {
  return vscode.window.onDidChangeActiveTextEditor((editor) => {
    const languageId = editor?.document.languageId;
    if (languageId && isSupportedLanguage(languageId)) {
      void provider.refresh(editor.document);
    } else {
      provider.clearView();
    }
  });
}

/**
 * 创建光标选择监听器（反向联动）
 */
function createSelectionListener(provider: SidebarProvider): Disposable {
  return vscode.window.onDidChangeTextEditorSelection((event) => {
    const languageId = event.textEditor.document.languageId;
    if (isSupportedLanguage(languageId) && languageId !== "markdown") {
      const line = event.selections[0]?.active.line ?? 0;
      provider.handleSelectionChange(line);
    }
  });
}

/**
 * 创建可见区域变化监听器（滚动同步）
 *
 * 当用户滚动编辑器时，将可见区域信息发送给侧边栏，
 * 侧边栏线性映射到对应的卡片位置进行同步滚动（不切换聚焦）。
 */
function createVisibleRangeListener(provider: SidebarProvider): Disposable {
  return vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
    const languageId = event.textEditor.document.languageId;
    if (!isSupportedLanguage(languageId)) {
      return;
    }
    const visibleRanges = event.visibleRanges;
    if (!visibleRanges || visibleRanges.length === 0) {
      return;
    }
    const document = event.textEditor.document;

    // 自动折行（word wrap）下 visibleRanges 是"可视行 → 逻辑位置"的数组：
    // 一个长逻辑行会折成多个可视行，每段是一个 Range。仅取 visibleRanges[0]
    // 会把折行部分的像素高度整个忽略掉，导致长行内滚动时侧边栏上下跳。
    // 这里取全部可视段起点/终点的字符偏移极值，其字符偏移中点即"视觉中心"
    // （等宽字体、行高一致的等比例映射）；再用 offsetAt/positionAt 把偏移
    // 精确映射回逻辑行 + 行内字符比例（小数行号），长逻辑行按其字符数
    // 等比计入视觉中心，插值不再随折行边界跳变。
    let startOffset = Number.POSITIVE_INFINITY;
    let endOffset = Number.NEGATIVE_INFINITY;
    for (const r of visibleRanges) {
      const s = document.offsetAt(r.start);
      const e = document.offsetAt(r.end);
      if (s < startOffset) startOffset = s;
      if (e > endOffset) endOffset = e;
    }
    // 小数行号：行号 + 行内字符比例（visual 中心对应的逻辑行）。
    // 字符索引可能等于行长（行末位置），clamp 到 <1 避免把"行末"当成下一行
    const toFractionalLine = (pos: vscode.Position): number => {
      const length = document.lineAt(pos.line).text.length;
      if (length <= 0) return pos.line;
      const fraction = Math.min(pos.character / length, 0.9999);
      return pos.line + fraction;
    };
    const top = document.positionAt(startOffset);
    const bottom = document.positionAt(endOffset);
    const mid = document.positionAt(Math.floor((startOffset + endOffset) / 2));
    provider.handleVisibleRangeChange(
      toFractionalLine(top),
      toFractionalLine(bottom),
      document.lineCount,
      toFractionalLine(mid),
    );
  });
}

/**
 * 创建关闭监听器 - 用于清理符号缓存
 * @returns Disposable 资源句柄，由调用方注册到 subscriptions 自动释放
 */
function createCloseListener(): Disposable {
  return vscode.workspace.onDidCloseTextDocument((document) => {
    clearSymbolCache(document.uri);
  });
}

/**
 * 扩展停用函数
 *
 * **何时被调用？：**
 * - VS Code 关闭
 * - 用户禁用扩展
 * - 扩展更新时
 *
 * **我们需要做什么？：**
 * 通常不需要做任何事，因为：
 * 1. subscriptions 中的 Disposable 会自动清理
 * 2. VS Code 会自动清理事件监听器
 *
 * 保留空函数是为了明确表示"我们知道有这个生命周期"
 */
export function deactivate(): void {
  clearAllSymbolCache();
}
