/**
 * 形状基类
 */
class Shape {
public:
  /** 宽度 */
  int width;
  /** 高度 */
  int height;

  /**
   * 构造函数
   *
   * @param w 宽度
   * @param h 高度
   */
  Shape(int w, int h) : width(w), height(h) {}

  /** 计算面积 */
  int area() const {
    return width * height;
  }

  /** 析构函数 */
  ~Shape() {}
};

/** 颜色枚举 */
enum Color {
  RED,
  GREEN,
  BLUE
};
