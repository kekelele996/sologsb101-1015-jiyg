/**
 * 巡检批次校验与对账（保护科）
 * - 巡检班上报批次里的保护级别只是现场带回的旧值，一律不采信，以古树现档为准；
 * - 保护科逐条校验，任一条不通过则整批退回重报（保护科台账不动）；
 * - 整批通过后对账：覆盖到的加固件按保护科周期 + 本次检查日期重算下次到期，
 *   原排期作废、清空 scheduledQuarter 重新进待检清单。
 */
import type { InspectionBatch, InspectionItem } from '../types/inspection'
import type { Support } from '../types/support'
import type { Tree } from '../types/tree'
import { daysBetween } from './dimension'

/** 单条校验问题（level=error 整批退回；level=info 仅提示不拦截） */
export interface ItemIssue {
  level: 'error' | 'info'
  message: string
}

export interface ItemValidation {
  ok: boolean
  issues: ItemIssue[]
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * 校验一条巡检上报记录。
 * @param todayDate 对账参考日期（默认调用方传入当天）
 */
export function validateInspectionItem(
  item: InspectionItem,
  index: number,
  supports: Support[],
  trees: Tree[],
  allItems: InspectionItem[],
  todayDate: string
): ItemValidation {
  const issues: ItemIssue[] = []
  const where = `第 ${index + 1} 条`

  if (item.supportId === '') {
    issues.push({ level: 'error', message: `${where}：未对应到加固件台账` })
    return { ok: false, issues }
  }
  const support = supports.find((row) => row.id === item.supportId)
  if (!support) {
    issues.push({ level: 'error', message: `${where}：加固件台账中找不到该件，可能已被删除，请核对后重报` })
    return { ok: false, issues }
  }
  const tree = trees.find((row) => row.id === support.treeId)
  if (!tree) {
    issues.push({ level: 'error', message: `${where}：加固件所属古树档案不存在，请核对后重报` })
  }
  if (item.type !== support.type) {
    issues.push({
      level: 'error',
      message: `${where}：加固件类型与台账不符（上报「${item.type}」，台账「${support.type}」）`,
    })
  }
  if (!DATE_RE.test(item.checkDate)) {
    issues.push({ level: 'error', message: `${where}：检查日期格式不正确，应为 YYYY-MM-DD` })
  } else {
    const future = daysBetween(todayDate, item.checkDate)
    if (future > 0) {
      issues.push({ level: 'error', message: `${where}：检查日期 ${item.checkDate} 晚于今天，不能预检补登` })
    }
    if (support.lastCheckDate !== '' && item.checkDate < support.lastCheckDate) {
      issues.push({
        level: 'error',
        message: `${where}：检查日期 ${item.checkDate} 早于台账最近检查日期 ${support.lastCheckDate}`,
      })
    }
  }
  if (item.note.trim() === '') {
    issues.push({ level: 'error', message: `${where}：缺少现场检查情况说明` })
  }
  const dup = allItems.filter((row) => row.supportId === item.supportId)
  if (dup.length > 1) {
    issues.push({ level: 'error', message: `${where}：同一批次内该加固件被上报 ${dup.length} 次，须去重后重报` })
  }

  // 保护级别：以现档为准。旧级别不一致只提示，不作为退回理由
  if (tree && item.reportedLevel !== '' && item.reportedLevel !== tree.protectLevel) {
    issues.push({
      level: 'info',
      message: `${where}：巡检带回的级别「${item.reportedLevel}」与现档「${tree.protectLevel}」不一致，对账以保护科现档为准`,
    })
  }

  return { ok: !issues.some((issue) => issue.level === 'error'), issues }
}

export interface BatchValidation {
  /** 是否全部通过（没有 error 级问题） */
  ok: boolean
  errorCount: number
  infoCount: number
  /** 每条对应的校验结果，与 items 同序 */
  perItem: ItemValidation[]
}

/** 整批校验：任一条不通过即整批不合格，须整批退回重报 */
export function validateBatch(
  batch: InspectionBatch,
  supports: Support[],
  trees: Tree[],
  todayDate: string
): BatchValidation {
  const perItem = batch.items.map((item, index) =>
    validateInspectionItem(item, index, supports, trees, batch.items, todayDate)
  )
  const errorCount = perItem.reduce(
    (acc, result) => acc + result.issues.filter((issue) => issue.level === 'error').length,
    0
  )
  const infoCount = perItem.reduce(
    (acc, result) => acc + result.issues.filter((issue) => issue.level === 'info').length,
    0
  )
  return { ok: errorCount === 0 && batch.items.length > 0, errorCount, infoCount, perItem }
}

/** 对账通过后对单件加固件的更新补丁 */
export interface ReconcilePatch {
  id: string
  lastCheckDate: string
  /** 原排期作废：清空已排季度，重新进待检清单 */
  scheduledQuarter: ''
  reconciledAt: string
}

/**
 * 生成对账补丁（调用方须先用 validateBatch 确认整批通过）。
 * 覆盖到的加固件：最近检查日期取该批内上报的最新检查日期。
 */
export function buildReconcilePatches(batch: InspectionBatch, isoStamp: string): ReconcilePatch[] {
  const latest = new Map<string, string>()
  batch.items.forEach((item) => {
    const prev = latest.get(item.supportId) ?? ''
    if (prev === '' || item.checkDate > prev) latest.set(item.supportId, item.checkDate)
  })
  return Array.from(latest.entries()).map(([id, lastCheckDate]) => ({
    id,
    lastCheckDate,
    scheduledQuarter: '',
    reconciledAt: isoStamp,
  }))
}
