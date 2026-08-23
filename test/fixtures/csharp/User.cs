/**
 * 用户实体
 */
public class User
{
    /** 用户ID */
    private int Id;

    /** 用户名 */
    public string Name { get; set; }

    /** 构造函数 */
    public User(int id)
    {
        Id = id;
    }

    /** 获取 ID */
    public int GetId()
    {
        return Id;
    }
}

/** 用户接口 */
public interface IUser
{
    /** 获取名称 */
    string GetName();
}

/** 用户类型枚举 */
public enum UserType
{
    ADMIN,
    NORMAL
}
