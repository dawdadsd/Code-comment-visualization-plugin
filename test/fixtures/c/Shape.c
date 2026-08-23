/**
 * 形状结构体
 */
typedef struct Shape {
  /** 宽度 */
  int width;
  /** 高度 */
  int height;
} Shape;

/**
 * 计算面积
 */
int area(struct Shape *shape) {
  return shape->width * shape->height;
}
