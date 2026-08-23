<?php

/**
 * 用户实体
 */
class User
{
    /** 用户ID */
    private $id;

    /**
     * 构造函数
     *
     * @param int $id 用户ID
     */
    public function __construct($id)
    {
        $this->id = $id;
    }

    /** 获取 ID */
    public function getId()
    {
        return $this->id;
    }
}

/** 用户接口 */
interface IUser
{
    /** 获取名称 */
    public function getName();
}

/** 角色枚举 */
enum Role
{
    case ADMIN;
    case USER;
}
