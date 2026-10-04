/**
 * 加固件检查周期标准（保护科维护）
 * 加固件检查周期不由巡检决定，而由保护科按古树保护级别统一定档；
 * 各档位的「检查周期（月）」与「每季度检查容量」集中存在本表 / 设置表。
 */
import type { ProtectLevel } from './tree'

/** 周期档位：与古树保护级别一致，保护科按级定档 */
export type CycleTier = ProtectLevel

export const CYCLE_TIER_OPTIONS: CycleTier[] = ['一级', '二级', '三级']

/** 各档位默认检查周期（月）：级别越高查得越勤 */
export const DEFAULT_CYCLE_MONTHS: Record<CycleTier, number> = {
  一级: 6,
  二级: 12,
  三级: 24,
}

/** 默认每季度检查容量（单季最多安排多少件加固件检查，排不完的顺延下一批） */
export const DEFAULT_QUARTER_CAPACITY = 3

export interface CycleStandard {
  /** 主键：保护级别档位 */
  id: CycleTier
  /** 该档位加固件检查周期（月） */
  checkCycleMon: number
  createdAt: string
  updatedAt: string
  revision: number
}
