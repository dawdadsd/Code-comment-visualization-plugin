/**
 * 用户服务类
 *
 * 提供用户查询与保存功能。
 *
 * @author xiaowu
 * @since 1.0
 */
public class UserService {

    /** 用户缓存 */
    private final Map<String, User> cache = new HashMap<>();

    /**
     * 根据 ID 查询用户
     *
     * @param id 用户ID
     * @return 用户对象，不存在时返回 null
     * @throws IllegalArgumentException id 为空时抛出
     */
    public User findById(Long id) {
        if (id == null) {
            throw new IllegalArgumentException("id 不能为空");
        }
        return cache.get(id.toString());
    }

    /**
     * 保存用户
     *
     * @param user 用户对象
     */
    public void save(User user) {
        cache.put(user.getId(), user);
    }

    /** 用户助手类 */
    static class UserHelper {

        /** 生成默认用户名 */
        String buildName() {
            return "guest";
        }
    }
}
