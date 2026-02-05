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
import type { WebviewView, WebviewViewProvider, WebviewViewResolveContext, CancellationToken, TextDocument, Disposable } from "vscode";
/**
 * Webview 侧边栏 Provider
 * - WebviewViewProvider：VS Code 要求的接口，用于创建侧边栏
 * - Disposable：资源清理接口，扩展卸载时调用
 */
export declare class SidebarProvider implements WebviewViewProvider, Disposable {
    private readonly extensionUri;
    /**
     * 当前的 Webview 实例 - download on demand
     */
    private view;
    /**
     * 当前文件的方法列表（用于反向联动的二分查找）
     * currentMethods : only replacements is allowed,not modification
     */
    private currentMethods;
    /**
     * 上次高亮的方法 ID
     * used to prevent duplicate highlighting
     */
    private lastHighlightId;
    /**
     * Javadoc 解析器实例
     */
    private readonly parser;
    /**
     * cn - 防抖后的高亮函数
     * en - debounced highlight function
     */
    private readonly debouncedHighlight;
    /**
     * 构造函数
     *
     * @param extensionUri - 扩展的根目录 URI
     * Webview 需要加载 CSS/JS 文件，但出于安全考虑，
     * 它不能随意访问本地文件，只能访问 extensionUri 下的文件
     */
    constructor(extensionUri: vscode.Uri);
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
    resolveWebviewView(webviewView: WebviewView, _context: WebviewViewResolveContext, _token: CancellationToken): void;
    /**
     * 刷新侧边栏内容
     *
     * @param document - 要解析的文档，不传则使用当前活动文档
     *
     * 【async/await 解释】
     * async 函数返回 Promise，可以用 await 等待异步操作完成
     * 这里 parser.parse() 是异步的（需要调用 VS Code API）
     */
    refresh(document?: TextDocument): Promise<void>;
    /**
     * 清空视图
     */
    clearView(): void;
    /**
     * cn - 处理光标选择变化（从 extension.ts 调用）
     * en - handle selection change (called from extension.ts)
     * @param line - 光标所在行号
     */
    handleSelectionChange(line: number): void;
    /**
     * 释放资源（Disposable 接口）
     *
     * 【何时被调用？】
     * 扩展被禁用或卸载时，VS Code 会调用这个方法
     * 让我们有机会清理资源（如定时器、事件监听器等）
     */
    dispose(): void;
    /**
     * cn - 更新高亮状态
     * en - update highlight state
     * @param cursorLine - 光标所在行
     */
    private updateHighlight;
    /**
     * cn - 处理 Webview 发来的消息
     * en - handle messages from Webview
     * @param message - 原始消息（类型未知）
     */
    private handleUpstreamMessage;
    /**
     * 跳转到指定行
     *
     * @param line - 目标行号
     */
    private jumpToLine;
    /**
     * 向 Webview 发送消息
     *
     * @param message - 要发送的消息
     *
     * 【void 操作符】
     * postMessage 返回 Thenable（类似 Promise）
     * 我们不关心它的结果，用 void 表示忽略返回值
     */
    private postMessage;
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
    private getHtmlContent;
    /**
     * 生成随机 nonce
     *
     * 【什么是 nonce？】
     * 一次性使用的随机字符串，用于防止 XSS 攻击
     * 只有带有正确 nonce 的 script 标签才会被执行
     */
    private getNonce;
}
