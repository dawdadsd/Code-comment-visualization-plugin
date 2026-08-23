//! 高级 Rust 语法

/// 形状特质
pub trait Shape {
    /// 计算面积
    fn area(&self) -> f64;
}

/// 圆形
pub struct Circle {
    /// 半径
    pub radius: f64,
}

impl Shape for Circle {
    /// 面积实现
    fn area(&self) -> f64 {
        3.14 * self.radius * self.radius
    }
}

/// 泛型容器
pub struct Container<T> {
    /// 存储值
    value: T,
}

impl<T> Container<T> {
    /// 获取值
    pub fn get(&self) -> &T {
        &self.value
    }
}
