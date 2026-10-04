/**
 * 加固件检查周期与季度排队工具（纯函数）
 * - 保护级别 → 生效周期（周期标准由保护科维护）
 * - 季度字符串解析（2026Q4）、到期日期归属季度
 * - 季度容量装箱：按到期日先后排入各季度，排不完的顺延到之后季度
 * 见 types/cycle.ts、types/plan.ts。
 */
import type { ProtectLevel } from '../types/tree'
import type { CycleStandard } from '../types/cycle'
import { DEFAULT_CYCLE_STANDARDS } from '../types/cycle'
import type { Support } from '../types/support'
import { addMonths } from './dimension'

/** 取某保护级别的生效周期月数；标准缺档时回退默认档位 */
export function cycleMonthsOf(level: ProtectLevel, standards: CycleStandard[]): number {
  const hit = standards.find((row) => row.id === level)
  if (hit && Number.isFinite(hit.checkCycleMon) && hit.checkCycleMon > 0) return hit.checkCycleMon
  return DEFAULT_CYCLE_STANDARDS[level]
}

/** 加固件的生效周期：一律以所属古树的现档保护级别为准（巡检带回的旧级别不参与） */
export function supportCycleMonths(support: Support, levelOf: (treeId: string) => ProtectLevel | undefined, standards: CycleStandard[]): number {
  const level = levelOf(support.treeId) ?? support.cycleLevel
  return cycleMonthsOf(level, standards)
}

/** 加固件到期检查日期 = 最近检查日期 + 生效周期；从未检查时返回空串 */
export function supportDueDate(support: Support, cycleMonths: number): string {
  if (support.lastCheckDate === '') return ''
  return addMonths(support.lastCheckDate, cycleMonths)
}

/** 日期所属季度，如 2026-10-04 → 2026Q4 */
export function quarterOf(date: string): string {
  const matched = /^(\d{4})-(\d{2})/.exec(date)
  if (!matched) return ''
  const year = Number(matched[1])
  const month = Number(matched[2])
  const quarter = Math.floor((month - 1) / 3) + 1
  return `${year}Q${quarter}`
}

/** 季度起始日期（含），如 2026Q4 → 2026-10-01 */
export function quarterStart(quarter: string): string {
  const matched = /^(\d{4})Q([1-4])$/.exec(quarter)
  if (!matched) return ''
  const year = Number(matched[1])
  const q = Number(matched[2])
  const firstMonth = (q - 1) * 3 + 1
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${year}-${pad(firstMonth)}-01`
}

/** 下一个季度 */
export function nextQuarter(quarter: string): string {
  const matched = /^(\d{4})Q([1-4])$/.exec(quarter)
  if (!matched) return quarter
  let year = Number(matched[1])
  let q = Number(matched[2]) + 1
  if (q > 4) {
    q = 1
    year += 1
  }
  return `${year}Q${q}`
}

export interface PackItem {
  supportId: string
  treeId: string
  /** 到期日；从未检查的加固件按最高优先（空串排最前） */
  dueDate: string
  cycleLevel: ProtectLevel
  checkCycleMon: number
}

export interface PackedItem extends PackItem {
  /** 最终排入的季度 */
  quarter: string
}

/**
 * 季度容量装箱。
 * 每件从「到期季度」起尝试占一个容量位，占满就顺延下一季度；
 * 从未检查 / 已超期（到期季度早于当前季度）的件从当前季度开始排队。
 * 输入应只包含需要待检计划的加固件（已查历史不参与）。
 */
export function packByQuarterCapacity(
  items: PackItem[],
  capacity: number,
  referenceQuarter: string,
): PackedItem[] {
  const safeCapacity = capacity > 0 ? Math.floor(capacity) : DEFAULT_FALLBACK_CAPACITY
  const ordered = [...items].sort((a, b) => {
    if (a.dueDate === '' && b.dueDate === '') return a.supportId.localeCompare(b.supportId)
    if (a.dueDate === '') return -1
    if (b.dueDate === '') return 1
    return a.dueDate.localeCompare(b.dueDate)
  })
  const used: Record<string, number> = {}
  const result: PackedItem[] = []
  for (const item of ordered) {
    let candidate = item.dueDate === '' ? referenceQuarter : quarterOf(item.dueDate)
    if (candidate < referenceQuarter) candidate = referenceQuarter
    while ((used[candidate] ?? 0) >= safeCapacity) {
      candidate = nextQuarter(candidate)
    }
    used[candidate] = (used[candidate] ?? 0) + 1
    result.push({ ...item, quarter: candidate })
  }
  return result
}

/** 容量设置非法时的兜底 */
export const DEFAULT_FALLBACK_CAPACITY = 2
