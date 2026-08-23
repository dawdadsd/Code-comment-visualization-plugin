//! 解析器模块

/// 解析器结构体
pub struct Parser {
    /// 当前行号
    line: u32,
}

/// 创建解析器
pub fn new() -> Parser {
    Parser { line: 0 }
}

/// 前进到下一行
pub fn advance(&mut self) {
    self.line += 1;
}
