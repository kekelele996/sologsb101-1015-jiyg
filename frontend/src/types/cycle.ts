/**
 * 加固件检查周期标准（CycleStandard）
 * 周期档位由保护科按保护级别统一制定，巡检班无权修改；
 * 加固件不再逐件手填周期，其生效周期由所属古树的「现档保护级别」查本表得到。
 */
import type { ProtectLevel } from './tree'

export interface CycleStandard {
  /** 主键：保护级别（一级 / 二级 / 三级） */
  id: ProtectLevel
  /** 该级别加固件的检查周期（月） */
  checkCycleMon: number
  createdAt: string
  updatedAt: string
  revision: number
}

/** 编辑周期标准的表单草稿 */
export interface CycleStandardDraft {
  checkCycleMon: number
}

/** 新建库 / 升级缺档时的默认周期：一级 6 个月、二级 12 个月、三级 24 个月 */
export const DEFAULT_CYCLE_STANDARDS: Record<ProtectLevel, number> = {
  一级: 6,
  二级: 12,
  三级: 24,
}

/** 设置表主键：每季度检查容量（保护科制定，排不完的加固件顺延下一季度） */
export const SETTING_QUARTER_CAPACITY = 'quarterCapacity'

/** 默认每季度可排检查的加固件数量 */
export const DEFAULT_QUARTER_CAPACITY = 2
