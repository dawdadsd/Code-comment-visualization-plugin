/**
 * 用户协议
 */
@protocol IUser
- (NSString *)getName;
@end

/**
 * 用户类
 */
@interface User : NSObject
/** 用户ID */
@property (nonatomic, assign) NSInteger userId;

/** 获取 ID */
- (NSInteger)getUserId;
@end
