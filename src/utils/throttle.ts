/**
 * throttle.ts - 节流工具函数
 *
 * **节流与防抖的区别：**
 * 防抖（debounce）：等事件停止触发一段时间后才执行一次——连续事件期间
 * 永远不执行（每来一个事件都重置计时器）。
 * 节流（throttle）：保证连续事件期间也以固定频率执行——首次调用立即执行
 * （leading），期间最多每 delay 毫秒执行一次，事件停止后用最后参数补执行
 * 一次（trailing）。
 *
 * **为什么需要节流？**
 * 滚动同步场景：visibleRanges 事件在滚动期间持续高频到达（每帧一次）。
 * 若用防抖，同步会被推迟到"滚动停止后"，滚动过程中侧边栏纹丝不动、
 * 停手后才猛地跳到位——表现为"不跟手"。节流让滚动期间持续同步，
 * trailing 兜底保证最终位置精确归位。
 *
 * @author xiaowu
 * @since 2026/02/04
 */

/**
 * 创建一个节流函数（leading + trailing）
 *
 * 行为：
 * - 空闲超过 delay 后首次调用立即执行（leading）
 * - 连续调用期间，最多每 delay 毫秒执行一次
 * - 事件停止后，若期间有被节流吞掉的调用，用最后一次参数补执行（trailing）
 *
 * @param fn - 要节流的原函数
 * @param delay - 最小执行间隔（毫秒）
 * @returns 节流后的新函数
 *
 * @example
 * const throttledSync = throttle((line: number) => sync(line), 30);
 * throttledSync(1); // 立即执行（leading）
 * throttledSync(2); // 30ms 内被吞掉，更新 pending
 * throttledSync(3); // 继续被吞掉，更新 pending
 * // 30ms 后执行一次（trailing），参数为最后一次的 3
 */
export function throttle<Args extends unknown[], R>(
  fn: (...args: Args) => R,
  delay: number,
): (...args: Args) => void {
  let lastRun = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingArgs: Args | null = null;

  // 返回一个包装原函数的新函数，带节流逻辑
  return (...args: Args): void => {
    // 先记录最新参数：无论本次调用是否被吞掉，trailing 都要用最新值
    pendingArgs = args;
    if (timer !== null) {
      // 已有排定的 trailing 执行，等待其触发即可
      return;
    }

    const elapsed = Date.now() - lastRun;
    if (elapsed >= delay) {
      // 距上次执行已超过 delay：立即执行（leading）
      lastRun = Date.now();
      pendingArgs = null;
      fn(...args);
      return;
    }

    // 距上次执行不足 delay：安排一次 trailing 执行（用最新的参数）
    timer = setTimeout(() => {
      timer = null;
      lastRun = Date.now();
      if (pendingArgs !== null) {
        fn(...pendingArgs);
      }
      pendingArgs = null;
    }, delay - elapsed);
  };
}
