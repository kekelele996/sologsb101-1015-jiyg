/**
 * 加固件季度检查批次（巡检班上报 → 保护科对账）
 * 巡检班上门做树体检查时顺带核到加固件，按季度批次上报；
 * 保护科逐件校验，一条不过整批退回重报；回齐后对账，
 * 覆盖到的加固件按保护科周期 + 最新检查日期重算，原排期作废、重新进待检清单。
 */
import type { SupportType } from './support'

/** 批次上报状态 */
export type BatchState = '待对账' | '已退回' | '已对账'

export const BATCH_STATE_OPTIONS: BatchState[] = ['待对账', '已退回', '已对账']

export const BATCH_STATE_LABEL: Record<BatchState, string> = {
  待对账: '待对账',
  已退回: '已退回（整批重报）',
  已对账: '已对账',
}

/** 批次内单件加固件的校验结果 */
export type ItemCheck = '待校验' | '通过' | '不通过'

/** 巡检上报的单件加固件检查结果（不可信快照：保护级别以保护科现档为准） */
export interface InspectionItem {
  /** 批次内条目 id（入库时补齐） */
  itemId: string
  /** 指向加固件台账（可能因台账删除而悬空，对账时按悬空件处理） */
  supportId: string
  type: SupportType
  /** 巡检现场带出的古树保护级别（仅留痕，对账不采信，以现档为准） */
  reportedLevel: string
  /** 巡检现场登记的本次检查日期 */
  checkDate: string
  /** 巡检现场发现的问题备注 */
  note: string
  /** 保护科逐条校验结果 */
  check: ItemCheck
  /** 不通过原因（保护科填写） */
  rejectReason: string
}

/** 加固件检查上报批次 */
export interface InspectionBatch {
  id: string
  /** 批次号，如 2026-Q1 */
  batchNo: string
  /** 巡检班上报季度，如 2026Q1 */
  quarter: string
  state: BatchState
  items: InspectionItem[]
  /** 整批退回时的退回原因（保护科填写） */
  returnReason: string
  /** 对账完成时间 */
  reconciledAt: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建批次的表单草稿 */
export interface InspectionBatchDraft {
  quarter: string
  items: Array<Omit<InspectionItem, 'itemId' | 'check' | 'rejectReason'>>
}
