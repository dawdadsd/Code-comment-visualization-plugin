/**
 * 泛型列表
 */
public class ListBox<T>
{
    /** 元素集合 */
    private List<T> _items = new();

    /** 添加元素 */
    public void Add(T item)
    {
        _items.Add(item);
    }

    /** 移除元素 */
    public bool Remove(T item)
    {
        return _items.Remove(item);
    }
}

/**
 * 点记录
 */
public record Point(int X, int Y);

/**
 * 静态计算器
 */
public static class Calculator
{
    /** 静态累加 */
    public static int Total { get; set; }

    /** 累加方法 */
    public static void Add(int value)
    {
        Total += value;
    }
}
