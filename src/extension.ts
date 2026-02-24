/**
 * extension.ts - 扩展入口文件
 *
 * 【VS Code 扩展的生命周期】
 * 1. 用户触发激活事件（如打开 Java 文件）
 * 2. VS Code 调用 activate() 函数
 * 3. 扩展注册各种功能（命令、视图、事件监听等）
 * 4. 用户使用扩展...
 * 5. VS Code 关闭或扩展被禁用时，调用 deactivate()
 *
 * 【本模块职责】
 * 只做三件事：
 * 1. 注册 WebviewViewProvider（侧边栏）
 * 2. 注册事件监听器（文件保存、光标移动等）
 * 3. 注册命令（刷新按钮等）
 *
 * 不做任何业务逻辑！业务逻辑在 SidebarProvider 中
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
 *【ExtensionContext 的作用】
 * 1. subscriptions：Disposable 数组，扩展卸载时自动清理
 * 2. extensionUri：扩展根目录的 URI
 * 3. globalState/workspaceState：持久化存储
 *
 * @param context - 扩展上下文，用于管理资源生命周期
 */
export function activate(context: vscode.ExtensionContext): void {
  console.log("[JavaDocSidebar] Extension is now active!");
  //register WebViewProvider for sidebar and panel
  const sidebarProvider = new SidebarProvider(context.extensionUri);
  //left bar view create
  const viewProviderDisposable = vscode.window.registerWebviewViewProvider(
    "javaDocSidebar",
    sidebarProvider,
    {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    },
  );
  // this three method is register event listeners

  const saveListener = createSaveListener(sidebarProvider);

  const editorChangeListener = createEditorChangeListener(sidebarProvider);

  const selectionListener = createSelectionListener(sidebarProvider);

  const closeListener = createCloseListener();

  // register command for refresh future

  const refreshCommand = vscode.commands.registerCommand(
    "javaDocSidebar.refresh",
    () => {
      void sidebarProvider.refresh();
    },
  );

  // register for subscriptions to auto dispose
  context.subscriptions.push(
    viewProviderDisposable,
    saveListener,
    editorChangeListener,
    selectionListener,
    closeListener,
    refreshCommand,
    sidebarProvider,
  );
}

/**
 * create save event listener
 */
function createSaveListener(provider: SidebarProvider): Disposable {
  return vscode.workspace.onDidSaveTextDocument((document) => {
    //TODO : More languages ​​will be supported in the future
    if (isSupportedLanguage(document.languageId)) {
      void provider.refresh(document);
    }
  });
}

/**
 * cn -创建编辑器切换监听器
 * en - create editor change listener
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
 * cn - 创建光标选择监听器（反向联动）
 * en - create selection listener (reverse linkage)
 *
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
 * 创建关闭监听器 - 用于清理符号缓存
 * @returns
 */
function createCloseListener(): Disposable {
  return vscode.workspace.onDidCloseTextDocument((document) => {
    clearSymbolCache(document.uri);
  });
}

/**
 * 扩展停用函数
 *
 * 【何时被调用？】
 * - VS Code 关闭
 * - 用户禁用扩展
 * - 扩展更新时
 *
 * 【我们需要做什么？】
 * 通常不需要做任何事，因为：
 * 1. subscriptions 中的 Disposable 会自动清理
 * 2. VS Code 会自动清理事件监听器
 *
 * 保留空函数是为了明确表示"我们知道有这个生命周期"
 */
export function deactivate(): void {
  clearAllSymbolCache();
}
