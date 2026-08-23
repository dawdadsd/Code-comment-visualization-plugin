/**
 * 高级语法演示：record / 泛型 / 接口默认方法 / 可变参数
 */
public record Point(int x, int y) {
    /** 计算距离 */
    public double distance() {
        return Math.sqrt(x * x + y * y);
    }
}

/**
 * 泛型容器
 */
public class Box<T> {
    /** 内部值 */
    private T value;

    /** 存储值 */
    public void setValue(T value) {
        this.value = value;
    }

    /** 获取值 */
    public T getValue() {
        return value;
    }

    /** 可变参数求和 */
    public static int sum(int... numbers) {
        int total = 0;
        for (int n : numbers) total += n;
        return total;
    }
}

/**
 * 处理器接口
 */
public interface Processor {
    /** 默认处理 */
    default String process(String input) {
        return input;
    }
}
