/**
 * 模板栈
 */
template <typename T>
class Stack {
public:
  /** 静态计数 */
  static int count;

  /** 入栈 */
  void push(const T &value) {
    data[count++] = value;
  }

  /** 出栈 */
  T pop() {
    return data[--count];
  }

private:
  /** 数据数组 */
  T data[100];
};

template <typename T>
int Stack<T>::count = 0;

/**
 * 形状接口
 */
class IShape {
public:
  /** 纯虚面积 */
  virtual double area() const = 0;
};
