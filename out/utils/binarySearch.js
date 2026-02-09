"use strict";
/**
 * binarySearch.ts - 光标定位工具
 *
 * 在按 `startLine` 升序的方法列表中，
 * 使用二分查找定位“光标当前所在的方法”。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.binarySearchMethod = binarySearchMethod;
/**
 * 在方法列表中查找光标所在方法。
 *
 * 算法：
 * (1) 通过 upper-bound 二分，找到最后一个 `startLine <= cursorLine` 的候选方法
 * (2) 校验 `cursorLine <= endLine`
 *
 * 复杂度：O(log n)
 */
function binarySearchMethod(methods, cursorLine) {
    if (methods.length === 0) {
        return null;
    }
    // 快速失败：光标在整体方法区间之外时，直接返回。
    const first = methods[0];
    const last = methods[methods.length - 1];
    if (first === undefined || last === undefined) {
        return null;
    }
    if (cursorLine < first.startLine || cursorLine > last.endLine) {
        return null;
    }
    const candidateIndex = findRightmostStartLineAtOrBefore(methods, cursorLine);
    if (candidateIndex < 0) {
        return null;
    }
    const candidate = methods[candidateIndex];
    if (candidate === undefined) {
        return null;
    }
    return isLineInsideMethod(candidate, cursorLine) ? candidate : null;
}
/**
 * 返回最后一个满足 `startLine <= cursorLine` 的下标。
 * 若不存在，返回 -1。
 */
function findRightmostStartLineAtOrBefore(methods, cursorLine) {
    let left = 0;
    let right = methods.length; // 右开区间 [left, right)
    while (left < right) {
        const mid = left + Math.floor((right - left) / 2);
        const method = methods[mid];
        if (method !== undefined && method.startLine <= cursorLine) {
            left = mid + 1;
        }
        else {
            right = mid;
        }
    }
    return left - 1;
}
function isLineInsideMethod(method, cursorLine) {
    return method.startLine <= cursorLine && cursorLine <= method.endLine;
}
//# sourceMappingURL=binarySearch.js.map