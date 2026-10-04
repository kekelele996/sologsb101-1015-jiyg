/**
 * 加固件（Support）
 * 支撑杆、拉纤、避雷设施，按检查周期自动提示超期未检查。
 */

/** 加固件类型 */
export type SupportType = '支撑杆' | '拉纤' | '避雷'

export const SUPPORT_TYPE_OPTIONS: SupportType[] = ['支撑杆', '拉纤', '避雷']

export interface Support {
  id: string
  /** 所属古树 */
  treeId: string
  /** 类型 */
  type: SupportType
  /** 安装日期 YYYY-MM-DD */
  installDate: string
  /**
   * 检查周期（月）。
   * 由保护科按古树保护级别统一定档；对账后按现档级别对应的周期标准重算，
   * 不再由巡检按次修改。仅保留历史手填值的兼容字段。
   */
  checkCycleMon: number
  /** 最近检查日期 YYYY-MM-DD（对账通过后以巡检上报的最新检查日期重算） */
  lastCheckDate: string
  /**
   * 已排入的检查季度，如 2026Q4；'' 表示尚未排入批次、留在待检清单排队。
   * 对账重算周期后原排期作废（清空），重新进待检清单。
   */
  scheduledQuarter: string
  /** 最近一次对账通过时间（ISO，留痕用），无则空串 */
  reconciledAt: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑加固件的表单草稿（巡检侧不可改周期与排期，故草稿不含这两项） */
export interface SupportDraft {
  treeId: string
  type: SupportType
  installDate: string
  checkCycleMon: number
  lastCheckDate: string
  scheduledQuarter?: string
}
