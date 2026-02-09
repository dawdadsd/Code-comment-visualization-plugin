/**
 * binarySearch.ts - 光标定位工具
 *
 * 在按 `startLine` 升序的方法列表中，
 * 使用二分查找定位“光标当前所在的方法”。
 */
import type { MethodDoc, LineNumber } from "../types.js";
/**
 * 在方法列表中查找光标所在方法。
 *
 * 算法：
 * (1) 通过 upper-bound 二分，找到最后一个 `startLine <= cursorLine` 的候选方法
 * (2) 校验 `cursorLine <= endLine`
 *
 * 复杂度：O(log n)
 */
export declare function binarySearchMethod(methods: readonly MethodDoc[], cursorLine: LineNumber): MethodDoc | null;
