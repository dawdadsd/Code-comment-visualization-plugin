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
/**
 * Webview 侧边栏 Provider
 * - WebviewViewProvider：VS Code 要求的接口，用于创建侧边栏
 * - Disposable：资源清理接口，扩展卸载时调用
 */
class SidebarProvider {
    extensionUri;
    /**
     * 当前的 Webview 实例 - download on demand
     */
    view;
    /**
     * 当前文件的方法列表（用于反向联动的二分查找）
     * currentMethods : only replacements is allowed,not modification
     */
    currentMethods = [];
    /**
     * 上次高亮的方法 ID
     * used to prevent duplicate highlighting
     */
    lastHighlightId = null;
    /**
     * Javadoc 解析器实例
     */
    parser;
    /**
     * cn - 防抖后的高亮函数
     * en - debounced highlight function
     */
    debouncedHighlight;
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
        }, 300);
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
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
        };
        webviewView.webview.html = this.getHtmlContent(webviewView.webview);
        // 监听 Webview 发来的消息（上行消息）
        webviewView.webview.onDidReceiveMessage((message) => {
            this.handleUpstreamMessage(message);
        });
        // 如果当前已经打开了 Java 文件，立即解析并显示
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor?.document.languageId === "java") {
            void this.refresh(activeEditor.document);
        }
    }
    // ========== 公共方法 ==========
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
        // 如果没传文档，使用当前活动的文档
        const doc = document ?? vscode.window.activeTextEditor?.document;
        // 检查是否是 Java 文件
        if (!doc || doc.languageId !== "java") {
            this.clearView();
            return;
        }
        try {
            // 解析文档
            const classDoc = await this.parser.parse(doc);
            // 更新状态
            this.currentMethods = classDoc.methods;
            this.lastHighlightId = null; // 重置高亮状态
            // 发送数据给 Webview
            this.postMessage({ type: "updateView", payload: classDoc });
        }
        catch (error) {
            console.error("[JavaDocSidebar] Parse error:", error);
            // 解析失败时保持当前视图不变
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
        // 目前没有需要清理的资源
        // 但保留这个方法，方便将来扩展
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
        // 先用类型守卫验证消息格式
        if (!(0, types_js_1.isUpstreamMessage)(message)) {
            console.warn("[JavaDocSidebar] Invalid upstream message:", message);
            return;
        }
        // 根据消息类型分发处理
        // 【switch 的类型收窄】
        // TypeScript 知道进入 case 'jumpToLine' 后，
        // message 的类型是 { type: 'jumpToLine', payload: { line: LineNumber } }
        switch (message.type) {
            case "jumpToLine":
                this.jumpToLine(message.payload.line);
                break;
            case "webviewReady":
                // Webview 加载完成，触发一次刷新
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
        if (!editor)
            return;
        // 创建位置和范围对象
        const position = new vscode.Position(line, 0);
        const range = new vscode.Range(position, position);
        // 设置光标位置
        editor.selection = new vscode.Selection(position, position);
        // 滚动编辑器，让目标行居中显示
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
        // 将本地文件路径转换为 Webview 可访问的 URI
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "sidebar.css"));
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "sidebar.js"));
        // 生成随机 nonce（用于 CSP）
        const nonce = this.getNonce();
        // 返回 HTML
        // 【Content-Security-Policy 解释】
        // default-src 'none'：默认禁止所有资源
        // style-src：允许加载样式
        // script-src 'nonce-xxx'：只允许带有指定 nonce 的脚本执行
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