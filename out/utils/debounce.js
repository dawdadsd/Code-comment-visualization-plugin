"use strict";
/**
 * debounce.ts - 防抖工具函数
 *
 * 【什么是防抖？】
 * 当一个事件频繁触发时（如光标移动），我们不想每次都执行处理函数
 * 防抖的策略是：等事件停止触发一段时间后，才执行一次
 *
 * 例如：用户快速移动光标，每毫秒都触发事件
 * 没有防抖：执行 1000 次/秒
 * 有防抖（300ms）：用户停止移动 300ms 后才执行 1 次
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.debounce = debounce;
/**
 * 创建一个防抖函数
 *
 * 【泛型 T extends (...args: Parameters<T>) => void 解释】
 * - T 是一个函数类型
 * - Parameters<T> 获取函数 T 的参数类型元组
 * - 返回值类型是 void（防抖函数不关心原函数的返回值）
 *
 * @param fn - 要防抖的原函数
 * @param delay - 延迟时间（毫秒）
 * @returns 防抖后的新函数
 *
 * @example
 * const debouncedLog = debounce((msg: string) => console.log(msg), 300);
 * debouncedLog('a'); // 不会立即执行
 * debouncedLog('b'); // 取消上一次，重新计时
 * debouncedLog('c'); // 取消上一次，重新计时
 * // 300ms 后，只打印 'c'
 */
function debounce(fn, delay) {
    let timeoutId = null;
    // return a new function that wraps the original function with ed
    return (...args) => {
        if (timeoutId !== null) {
            clearTimeout(timeoutId);
        }
        // set a new timeout to call the function after the delay
        timeoutId = setTimeout(() => {
            fn(...args);
            timeoutId = null;
        }, delay);
    };
}
//# sourceMappingURL=debounce.js.map