package main

// Order 订单结构体
type Order struct {
	// ID 订单号
	ID string
	// Amount 金额
	Amount float64
}

// NewOrder 创建订单
func NewOrder(id string) *Order {
	return &Order{ID: id}
}

// Total 计算总价
func (o *Order) Total() float64 {
	return o.Amount
}
