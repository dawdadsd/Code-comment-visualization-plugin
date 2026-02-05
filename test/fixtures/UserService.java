package com.example.service;

import java.util.ArrayList;
import java.util.List;

/**
 * 用户服务类，提供用户相关的核心业务操作。
 *
 * @author zhangsan
 * @since 1.0
 */
public class UserService {

    /**
     * 根据ID查找用户。
     *
     * @param id 用户的唯一标识
     * @return 匹配的用户对象，不存在则返回 null
     * @throws IllegalArgumentException 当 id 为 null 时抛出
     */
    public User findById(Long id) {
        if (id == null) {
            throw new IllegalArgumentException("id cannot be null");
        }
        return new User(id, "Test User");
    }

    /**
     * 保存用户信息。
     *
     * @param user  要保存的用户对象
     * @param force 是否强制覆盖已存在的用户
     * @return 保存后的用户对象（包含生成的ID）
     * @throws IllegalArgumentException 当 user 为 null 时抛出
     * @throws DuplicateUserException   当用户已存在且 force 为 false 时抛出
     * @since 1.1
     */
    public User save(User user, boolean force) {
        if (user == null) {
            throw new IllegalArgumentException("user cannot be null");
        }
        return user;
    }

    /**
     * 查询所有用户列表。
     *
     * @return 用户列表，空时返回空列表而非 null
     * @see User
     * @see #findById(Long)
     */
    public List<User> findAll() {
        return new ArrayList<>();
    }

    // 这个方法没有 Javadoc 注释
    public void deleteById(Long id) {
        // 删除逻辑
    }

    /**
     * @deprecated 请使用 {@link #findById(Long)} 替代
     * @param userId 用户ID
     * @return 用户对象
     */
    @Deprecated
    public User getUser(Long userId) {
        return findById(userId);
    }

    /**
     * 内部帮助类，处理用户数据转换。
     */
    private static class UserHelper {

        /**
         * 将用户对象转换为 DTO。
         *
         * @param user           源用户对象
         * @param includeDetails 是否包含详细信息
         * @return 转换后的 DTO 对象
         */
        public UserDTO toDTO(User user, boolean includeDetails) {
            return new UserDTO(user);
        }
    }
}
