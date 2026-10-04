/**
 * 加固件待检计划（SupportCheckPlan）
 * 每件加固件在任意时刻最多只有一条「待检」计划；
 * 对账重算或登记检查后，原待检计划作废，按保护科周期生成的新计划重新排队。
 * 每季度检查容量有限（设置表），按到期先后装箱，排不完的顺延到之后季度。
 * 已查计划为冻结历史，后续重排与对账都不再改动（查完的不再改）。
 */

/** 计划状态 */
export type PlanStatus = '待检' | '已查' | '已作废'

export const PLAN_STATUS_OPTIONS: PlanStatus[] = ['待检', '已查', '已作废']

export interface SupportCheckPlan {
  id: string
  /** 对应加固件 */
  supportId: string
  /** 冗余古树 id，便于筛选展示 */
  treeId: string
  /** 排入的季度，如 2026Q4 */
  quarter: string
  /** 本条计划的到期检查日期 YYYY-MM-DD（最近检查日期 + 生效周期） */
  dueDate: string
  /** 排队时依据的周期档位（保护级别），重排后重新取值 */
  cycleLevel: string
  /** 排队时依据的周期月数 */
  checkCycleMon: number
  /** 状态 */
  status: PlanStatus
  /** 实际检查日期（状态为已查时填写，对账批次日期或登记日期） */
  checkedDate: string
  /** 来源：批次对账 / 手动登记 / 初始编排 */
  sourceBatchId: string
  createdAt: string
  updatedAt: string
  revision: number
}
