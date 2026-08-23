//! 链表模块

/// 链表节点
pub enum Node<T> {
    /// 空节点
    Nil,
    /// 值节点
    Cons(T, Box<Node<T>>),
}

/// 链表实现
pub struct LinkedList<T> {
    /// 头节点
    head: Option<Node<T>>,
}

impl<T> LinkedList<T> {
    /// 创建空链表
    pub fn new() -> LinkedList<T> {
        LinkedList { head: None }
    }
}
