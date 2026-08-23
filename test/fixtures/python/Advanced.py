"""高级 Python 语法：装饰器 / 多继承 / 异步"""


class Mixin:
    """混入基类"""

    def extra(self) -> str:
        """附加方法"""
        return "extra"


class Counter(Mixin):
    """计数器"""

    _count: int = 0

    @classmethod
    def create(cls) -> "Counter":
        """工厂方法"""
        return cls()

    @staticmethod
    def clamp(value: int) -> int:
        """钳制数值"""
        return max(0, value)

    @property
    def count(self) -> int:
        """当前计数"""
        return self._count

    async def fetch(self) -> int:
        """异步获取"""
        return self._count
