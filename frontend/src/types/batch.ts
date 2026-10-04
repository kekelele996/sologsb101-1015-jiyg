/**
 * 树体检查批次（SurveyBatch）
 * 巡检班上门检查后把检查记录整批交回保护科：
 * - 草稿：巡检班在编，可继续增删检查记录；
 * - 已交回：等待保护科核对，批次内检查记录锁定；
 * - 已退回：保护科发现任意一条有误，整批退回，保护科台账不动，记录解锁由巡检班重报；
 * - 已对账：批次交齐核对无误，保护科据此重算覆盖到的加固件并重排待检清单。
 */
import type { ProtectLevel } from './tree'

/** 批次状态 */
export type BatchStatus = '草稿' | '已交回' | '已退回' | '已对账'

export const BATCH_STATUS_OPTIONS: BatchStatus[] = ['草稿', '已交回', '已退回', '已对账']

export interface SurveyBatch {
  id: string
  /** 批次名称，如「2026 年第三季度国子监片区巡检」 */
  name: string
  /** 巡检班上门日期（季度归属以此日期为准） */
  visitDate: string
  /** 计划检查的古树株数（交回条数需与计划数一致，即「回齐」才可对账） */
  plannedCount: number
  /** 本批交回的检查记录 id 列表 */
  surveyIds: string[]
  /** 状态 */
  status: BatchStatus
  /**
   * 交回时逐树带回的保护级别（巡检记录上的旧级别），key = treeId。
   * 仅作对照；对账与周期重算一律以古树现档为准。
   */
  levelSnapshot: Record<string, ProtectLevel>
  /** 整批退回原因（有一条不对即整批退回时填写） */
  returnReason: string
  /** 交回时间（ISO） */
  submittedAt: string
  /** 对账时间（ISO） */
  reconciledAt: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建批次的表单草稿 */
export interface SurveyBatchDraft {
  name: string
  visitDate: string
  plannedCount: number
}
