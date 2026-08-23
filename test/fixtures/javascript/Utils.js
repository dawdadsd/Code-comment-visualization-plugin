/**
 * 工具类
 */
class Utils {
  /** 静态计数 */
  static count = 0;

  constructor() {
    this.value = 0;
  }

  /** 增加计数 */
  increment() {
    this.value += 1;
  }

  /** 减少计数 */
  decrement() {
    this.value -= 1;
  }
}

/** 求和函数 */
function sum(a, b) {
  return a + b;
}
