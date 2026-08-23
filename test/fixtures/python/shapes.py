"""形状模块"""


class Shape:
    """形状基类"""

    def area(self) -> float:
        """计算面积"""
        return 0.0


class Circle(Shape):
    """圆形"""

    radius: float = 1.0

    def area(self) -> float:
        """圆形面积"""
        return 3.14 * self.radius ** 2
