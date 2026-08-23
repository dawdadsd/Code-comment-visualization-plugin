# 用户模块
module UserModule
  # 用户类
  class User
    # 初始化用户
    def initialize(name)
      @name = name
    end

    # 获取名称
    def name
      @name
    end

    # 类方法：创建用户
    def self.create(name)
      User.new(name)
    end
  end
end
