/**
 * 用户实体
 */
class User(
    /** 用户ID */
    private val id: Int,
) {
    /** 用户名 */
    var name: String = ""

    /** 获取 ID */
    fun getId(): Int {
        return id
    }

    /** 辅助工厂 */
    companion object {
        /** 创建空用户 */
        fun empty(): User = User(0)
    }
}

/** 用户接口 */
interface IUser {
    /** 获取名称 */
    fun getName(): String
}

/** 角色枚举 */
enum class Role {
    /** 管理员 */
    ADMIN,
    /** 普通用户 */
    USER,
}
