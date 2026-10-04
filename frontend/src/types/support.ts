/**
 * 加固件（Support）
 * 支撑杆、拉纤、避雷设施，属保护科台账。
 * 检查周期不由本件手填，而由所属古树的「现档保护级别」按周期标准（CycleStandard）派生；
 * cycleLevel 记录本件上次重算时采用的级别档位，仅用于提示「级别已变更，待对账重算」。
 * 最近检查日期只在检查批次对账成功后按「批次内该树最新检查日期」回写。
 */

/** 加固件类型 */
export type SupportType = '支撑杆' | '拉纤' | '避雷'

export const SUPPORT_TYPE_OPTIONS: SupportType[] = ['支撑杆', '拉纤', '避雷']

import type { ProtectLevel } from './tree'

export interface Support {
  id: string
  /** 所属古树 */
  treeId: string
  /** 类型 */
  type: SupportType
  /** 安装日期 YYYY-MM-DD */
  installDate: string
  /** 周期档位：上次对账重算时古树的保护级别；新登记件取古树现档级别 */
  cycleLevel: ProtectLevel
  /** 最近检查日期 YYYY-MM-DD（仅由批次对账回写） */
  lastCheckDate: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑加固件的表单草稿（周期由保护级别派生，不在表单里填写） */
export interface SupportDraft {
  treeId: string
  type: SupportType
  installDate: string
  lastCheckDate: string
}
