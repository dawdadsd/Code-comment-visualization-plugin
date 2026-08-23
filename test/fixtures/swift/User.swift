/**
 * 用户实体
 */
class User {
    /** 用户ID */
    var id: Int
    /** 用户名 */
    let name: String

    /** 初始化器 */
    init(id: Int, name: String) {
        self.id = id
        self.name = name
    }

    /** 获取描述 */
    func description() -> String {
        return "\(id): \(name)"
    }
}

/** 描述协议 */
protocol Describable {
    /** 描述方法 */
    func describe() -> String
}

/** 颜色枚举 */
enum Color {
    case red
    case green
}
