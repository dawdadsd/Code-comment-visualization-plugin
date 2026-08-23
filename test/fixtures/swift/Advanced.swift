/**
 * 泛型队列
 */
class Queue<T> {
    /** 元素数组 */
    private var items: [T] = []

    /** 入队 */
    func enqueue(_ item: T) {
        items.append(item)
    }

    /** 出队 */
    func dequeue() -> T? {
        return items.isEmpty ? nil : items.removeFirst()
    }
}

/**
 * 温度包装
 */
struct Temperature {
    /** 摄氏值 */
    var celsius: Double

    /** 华氏转换 */
    var fahrenheit: Double {
        get { return celsius * 9 / 5 + 32 }
        set { celsius = (newValue - 32) * 5 / 9 }
    }
}

/** 字符串扩展 */
extension String {
    /** 反转 */
    func reversed2() -> String {
        return String(self.reversed())
    }
}
