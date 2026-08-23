/**
 * 订单状态枚举
 */
public enum OrderStatus {
    /** 待支付 */
    PENDING("P", 0),
    /** 已支付 */
    PAID("A", 1),
    /** 已取消 */
    CANCELLED("C", 2);

    private final String code;
    private final int value;

    OrderStatus(String code, int value) {
        this.code = code;
        this.value = value;
    }

    /** 获取状态码 */
    public String getCode() {
        return code;
    }
}
