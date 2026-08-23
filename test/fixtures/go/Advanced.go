package main

// 泛型栈
type Stack[T any] struct {
	// 元素列表
	items []T
}

// 入栈
func (s *Stack[T]) Push(item T) {
	s.items = append(s.items, item)
}

// 出栈
func (s *Stack[T]) Pop() T {
	if len(s.items) == 0 {
		var zero T
		return zero
	}
	item := s.items[len(s.items)-1]
	s.items = s.items[:len(s.items)-1]
	return item
}

// 嵌入基类
type Base struct {
	// 名称
	Name string
}

// 派生结构
type Derived struct {
	Base
	// 映射表
	Lookup map[string]int
}
