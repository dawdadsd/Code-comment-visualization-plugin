/**
 * throttle.test.ts - throttle 节流工具单元测试
 *
 * 覆盖：
 * - 空闲后首次调用立即执行（leading）
 * - 连续调用期间按固定间隔执行（不超过 delay 一次）
 * - 事件停止后 trailing 兜底（用最后一次参数）
 * - 连续风暴下持续执行（与防抖的关键区别：防抖在连续事件期间永不执行）
 */

import { throttle } from "../src/utils/throttle";

describe("throttle 节流", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("空闲后首次调用立即执行（leading）", () => {
    const fn = jest.fn();
    const throttled = throttle(fn, 100);

    throttled(1);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenLastCalledWith(1);
  });

  it("间隔内的调用被吞掉，trailing 用最后一次参数执行", () => {
    const fn = jest.fn();
    const throttled = throttle(fn, 100);

    throttled(1); // t=0：leading 立即执行
    throttled(2); // t=0：间隔内，吞掉
    throttled(3); // t=0：间隔内，吞掉，更新 pending

    expect(fn).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(100); // t=100：trailing 兜底执行

    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith(3);
  });

  it("事件停止后仅补执行一次 trailing，之后不再触发", () => {
    const fn = jest.fn();
    const throttled = throttle(fn, 100);

    throttled(1);
    throttled(2);
    throttled(3);
    jest.advanceTimersByTime(99);
    expect(fn).toHaveBeenCalledTimes(1); // 仅 leading

    jest.advanceTimersByTime(1); // t=100：trailing
    expect(fn).toHaveBeenCalledTimes(2);

    jest.advanceTimersByTime(1000); // 停止后不再触发
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("连续事件期间按节流间隔持续执行（滚动同步场景）", () => {
    const fn = jest.fn();
    const throttled = throttle(fn, 30);

    throttled(1); // t=0：leading
    jest.advanceTimersByTime(10); // t=10
    throttled(2); // 调度 trailing 于 t=40
    jest.advanceTimersByTime(10); // t=20
    throttled(3); // pending 更新为 3
    jest.advanceTimersByTime(20); // t=40：trailing 执行（参数 3）

    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith(3);

    throttled(4); // t=40：距上次执行 0ms，调度 trailing 于 t=70
    jest.advanceTimersByTime(30); // t=70

    expect(fn).toHaveBeenCalledTimes(3);
    expect(fn).toHaveBeenLastCalledWith(4);
  });

  it("长时间连续调用下执行频率被限制在间隔内", () => {
    const fn = jest.fn();
    const throttled = throttle(fn, 30);

    // 每 10ms 一次调用，持续 500ms：执行次数应约为 500/30 ≈ 17 次
    throttled(0);
    for (let i = 0; i < 50; i++) {
      jest.advanceTimersByTime(10);
      throttled(i + 1);
    }

    // leading 1 次 + 每 30ms 一次（含 trailing），上限 20 次以内
    expect(fn.mock.calls.length).toBeGreaterThan(10);
    expect(fn.mock.calls.length).toBeLessThanOrEqual(20);
  });
});
