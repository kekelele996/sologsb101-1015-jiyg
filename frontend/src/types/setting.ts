/**
 * 保护科全局设置
 * 与具体古树无关、由保护科统管的排期参数：加固件每季度检查容量。
 * 单例行：id 固定为 SETTING_ID。
 */

/** 设置表固定主键（单行配置） */
export const SETTING_ID = 'app'

export interface AppSetting {
  id: typeof SETTING_ID
  /**
   * 每季度加固件检查容量：单季最多排入多少件，
   * 排不完的加固件排队等下一批；已查完（对账通过）的不再改期。
   */
  quarterCapacity: number
  createdAt: string
  updatedAt: string
  revision: number
}
