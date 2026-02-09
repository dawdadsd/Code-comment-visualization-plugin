"use strict";
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
exports.SidebarProvider = void 0;
const vscode = __importStar(require("vscode"));
const JavaDocParser_js_1 = require("./parser/JavaDocParser.js");
const debounce_js_1 = require("./utils/debounce.js");
const binarySearch_js_1 = require("./utils/binarySearch.js");
const types_js_1 = require("./types.js");
const HIGHLIGHT_DEBOUNCE_DELAY = 300;
/**
 * Webview 侧边栏 Provider
 * - WebviewViewProvider：VS Code 要求的接口，用于创建侧边栏
 * - Disposable：资源清理接口，扩展卸载时调用
 */
class SidebarProvider {
    extensionUri;
    view;
    currentMethods = [];
    lastHighlightId = null;
    parser;
    debouncedHighlight;
    webviewMessageDisposable;
    /**
     * 构造函数
     *
     * @param extensionUri - 扩展的根目录 URI
     * Webview 需要加载 CSS/JS 文件，但出于安全考虑，
     * 它不能随意访问本地文件，只能访问 extensionUri 下的文件
     */
    constructor(extensionUri) {
        this.extensionUri = extensionUri;
        this.parser = new JavaDocParser_js_1.JavaDocParser();
        this.debouncedHighlight = (0, debounce_js_1.debounce)((line) => {
            this.updateHighlight((0, types_js_1.LineNumber)(line));
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
    resolveWebviewView(webviewView, _context, _token) {
        this.view = webviewView;
        this.configureWebview(webviewView.webview);
        this.registerWebviewMessageListener(webviewView.webview);
        void this.refresh();
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
    async refresh(document) {
        const doc = this.getTargetSupportDocument(document);
        if (!doc) {
            this.clearView();
            return;
        }
        try {
            const classDoc = await this.parser.parse(doc);
            this.currentMethods = classDoc.methods;
            this.lastHighlightId = null;
            this.postMessage({ type: "updateView", payload: classDoc });
        }
        catch (error) {
            console.error("[JavaDocSidebar] Parse error:", error);
        }
    }
    /**
     * 清空视图
     */
    clearView() {
        this.currentMethods = [];
        this.lastHighlightId = null;
        this.postMessage({ type: "clearView" });
    }
    /**
     * cn - 处理光标选择变化（从 extension.ts 调用）
     * en - handle selection change (called from extension.ts)
     * @param line - 光标所在行号
     */
    handleSelectionChange(line) {
        this.debouncedHighlight(line);
    }
    /**
     * 释放资源（Disposable 接口）
     *
     * 【何时被调用？】
     * 扩展被禁用或卸载时，VS Code 会调用这个方法
     * 让我们有机会清理资源（如定时器、事件监听器等）
     */
    dispose() {
        this.webviewMessageDisposable?.dispose();
        this.webviewMessageDisposable = undefined;
        this.view = undefined;
        this.currentMethods = [];
        this.lastHighlightId = null;
    }
    /**
     * cn - 更新高亮状态
     * en - update highlight state
     * @param cursorLine - 光标所在行
     */
    updateHighlight(cursorLine) {
        const method = (0, binarySearch_js_1.binarySearchMethod)(this.currentMethods, cursorLine);
        const newId = method?.id ?? null;
        if (newId === this.lastHighlightId) {
            return;
        }
        this.lastHighlightId = newId;
        if (newId) {
            this.postMessage({ type: "highlightMethod", payload: { id: newId } });
        }
    }
    /**
     * cn - 处理 Webview 发来的消息
     * en - handle messages from Webview
     * @param message - 原始消息（类型未知）
     */
    handleUpstreamMessage(message) {
        if (!(0, types_js_1.isUpstreamMessage)(message)) {
            console.warn("[JavaDocSidebar] Invalid upstream message:", message);
            return;
        }
        switch (message.type) {
            case "jumpToLine":
                this.jumpToLine(message.payload.line);
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
    jumpToLine(line) {
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
     * 向 Webview 发送消息
     *
     * @param message - 要发送的消息
     *
     * 【void 操作符】
     * postMessage 返回 Thenable（类似 Promise）
     * 我们不关心它的结果，用 void 表示忽略返回值
     */
    postMessage(message) {
        void this.view?.webview.postMessage(message);
    }
    /**
     * 配置 Webview（设置 HTML 内容和安全选项）
     * @param webview webview 实例
     */
    configureWebview(webview) {
        webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
        };
        webview.html = this.getHtmlContent(webview);
    }
    /**
     * 注册 Webview 消息监听器
     * @param webview webview 实例
     */
    registerWebviewMessageListener(webview) {
        this.webviewMessageDisposable?.dispose();
        this.webviewMessageDisposable = webview.onDidReceiveMessage((message) => {
            this.handleUpstreamMessage(message);
        });
    }
    /**
     * 获取目标 Java 文档
     * @param document - 可选的文本文档
     * @returns 符合条件的 Java 文档，或 undefined
     */
    getTargetSupportDocument(document) {
        const candidate = document ?? vscode.window.activeTextEditor?.document;
        if (!candidate || !(0, types_js_1.isSupportedLanguage)(candidate.languageId)) {
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
    getHtmlContent(webview) {
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "sidebar.css"));
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "sidebar.js"));
        const nonce = this.getNonce();
        return /* html */ `
      <!DOCTYPE html>
      <html lang="zh-CN">
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy"
              content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <link href="${styleUri.toString()}" rel="stylesheet">
        <title>JavaDoc Sidebar</title>
      </head>
      <body>
        <div id="root"></div>
        <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
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
    getNonce() {
        const array = new Uint32Array(4);
        crypto.getRandomValues(array);
        return Array.from(array, (n) => n.toString(36)).join("");
    }
}
exports.SidebarProvider = SidebarProvider;
//# sourceMappingURL=SidebarProvider.js.map