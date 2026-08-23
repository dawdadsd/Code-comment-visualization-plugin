/**
 * 数据类
 */
data class UserInfo(
    /** 用户ID */
    val id: Int,
    /** 用户名 */
    val name: String,
)

/**
 * 泛型仓库
 */
class Repo<T> {
    /** 延迟初始化 */
    lateinit var items: List<T>

    /** 保存项目 */
    fun save(item: T): Boolean {
        return true
    }
}

/** 字符串扩展 */
fun String.shout(): String {
    return this.uppercase()
}
