"""计算器模块"""


class Calculator:
    """计算器类"""

    count: int = 0

    def add(self, value: int) -> int:
        """加法运算"""
        self.count += value
        return self.count

    def sub(self, value: int) -> int:
        """减法运算"""
        self.count -= value
        return self.count
