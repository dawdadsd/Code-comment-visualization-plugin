/**
 * 用户实体
 */
class User(val id: Int) {
  /** 用户名 */
  var name: String = ""

  /** 获取 ID */
  def getId(): Int = id
}

/** 用户特质 */
trait IUser {
  /** 获取名称 */
  def getName(): String
}

/** 用户工厂 */
object UserFactory {
  /** 创建用户 */
  def create(id: Int): User = new User(id)
}
