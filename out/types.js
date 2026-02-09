"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_CONFIG = exports.EMPTY_TAG_TABLE = exports.ACCESS_MODIFIERS = exports.FilePath = exports.MethodId = exports.LineNumber = void 0;
exports.isUpstreamMessage = isUpstreamMessage;
exports.isSupportedLanguage = isSupportedLanguage;
const LineNumber = (n) => n;
exports.LineNumber = LineNumber;
const MethodId = (id) => id;
exports.MethodId = MethodId;
const FilePath = (path) => path;
exports.FilePath = FilePath;
exports.ACCESS_MODIFIERS = [
    "public",
    "protected",
    "private",
    "default",
];
/**
 * nul tag tables : method no javadoc use this
 */
exports.EMPTY_TAG_TABLE = {
    params: [],
    returns: null,
    throws: [],
    since: null,
    author: null,
    deprecated: null,
    see: [],
};
/**
 * 类型守卫 - 运行时检查消息是否合法
 *
 *@implNote : 为什么我们需要 类型守卫？
              postMessage 传来的数据是 unknown 类型（可能是任何东西）
 *            我们需要在运行时验证它确实是 UpstreamMessage
              is -> tell TypeScript if true ,value is UpstreamMessage
 */
function isUpstreamMessage(value) {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    // tell TypeScript value is Record<string,unknown>
    const msg = value;
    switch (msg["type"]) {
        case "jumpToLine":
            // jumpToLine 需要有 payload.line 且是数字
            return (typeof msg["payload"] === "object" &&
                msg["payload"] !== null &&
                typeof msg["payload"]["line"] === "number");
        case "webviewReady":
            return true;
        default:
            return false;
    }
}
/**
 * 默认配置
 */
exports.DEFAULT_CONFIG = {
    enableAutoHighlight: true,
    debounceDelay: 300,
    maxMethods: 200,
};
const SUPPORTED_LANGUAGE_IDS = new Set([
    "java",
    "typescript",
    "javascript",
]);
function isSupportedLanguage(languageId) {
    return SUPPORTED_LANGUAGE_IDS.has(languageId);
}
//# sourceMappingURL=types.js.map