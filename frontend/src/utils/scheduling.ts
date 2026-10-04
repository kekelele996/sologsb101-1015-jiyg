/**
 * 加固件检查排期（保护科）
 * 周期来源唯一化：加固件检查周期 = 古树「现档保护级别」对应的周期标准，
 * 巡检在现场发现的倾斜超限 / 空洞高风险不改变周期。
 *
 * 季度排期：每季度容量有限，到期（含已超期）的加固件按到期日先后入排，
 * 当季排满后其余的留在待检清单排队等下一批；对账通过的加固件原排期作废、
 * 清空排期季度重新排队，已查完的不再改。
 */
import type { Support } from '../types/support'
import type { Tree } from '../types/tree'
import type { CycleStandard, CycleTier } from '../types/cycle'
import { addMonths } from './dimension'
import { quarterEnd, quarterOrder } from './quarter'
import { today } from './id'

/**
 * 有效检查周期（月）：优先取保护科按现档级别发布的周期标准；
 * 取不到标准时回退加固件台账上的历史手填值。
 */
export function effectiveCycleMon(
  support: Support,
  tree: Tree | null | undefined,
  standards: CycleStandard[]
): number {
  if (tree) {
    const hit = standards.find((row) => row.id === (tree.protectLevel as CycleTier))
    if (hit && Number.isFinite(hit.checkCycleMon) && hit.checkCycleMon > 0) {
      return hit.checkCycleMon
    }
  }
  return support.checkCycleMon
}

/** 下次应检查日期：最近检查日期（无则安装日期）+ 有效周期 */
export function supportDueDate(
  support: Support,
  tree: Tree | null | undefined,
  standards: CycleStandard[]
): string {
  const base = support.lastCheckDate !== '' ? support.lastCheckDate : support.installDate
  if (base === '') return ''
  return addMonths(base, effectiveCycleMon(support, tree, standards))
}

/** 是否已超期（按保护科有效周期判定） */
export function isSupportOverdueEffective(
  support: Support,
  tree: Tree | null | undefined,
  standards: CycleStandard[],
  reference = today()
): boolean {
  const due = supportDueDate(support, tree, standards)
  if (due === '') return true
  return due < reference
}

export type ScheduleBucket = 'planned' | 'queued' | 'future' | 'upcoming'

export interface ScheduleEntry {
  support: Support
  tree: Tree | null
  cycleMon: number
  due: string
  bucket: ScheduleBucket
  /** 已排入 / 建议排入的季度；排队 / 未到期未排时为空串 */
  assignedQuarter: string
}

export interface SchedulePlan {
  entries: ScheduleEntry[]
  /** 本季度已占用名额（含此前已排入本季度的） */
  usedCapacity: number
  /** 本季度容量 */
  capacity: number
  /** 建议新排入本季度的加固件（落库时写 scheduledQuarter） */
  assignments: Array<{ id: string; quarter: string }>
  /** 容量不足、顺延下一批的加固件数 */
  queuedCount: number
}

/**
 * 按季度容量生成排期方案（纯函数，不落库）。
 * @param current 当前季度 YYYYQn
 * @param capacity 每季度检查容量
 */
export function buildSchedule(
  supports: Support[],
  trees: Tree[],
  standards: CycleStandard[],
  current: string,
  capacity: number
): SchedulePlan {
  const treeMap = new Map(trees.map((tree) => [tree.id, tree]))
  const endOfQuarter = quarterEnd(current)
  const cap = Math.max(0, Math.floor(capacity))

  const entries: ScheduleEntry[] = supports.map((support) => {
    const tree = treeMap.get(support.treeId) ?? null
    const cycleMon = effectiveCycleMon(support, tree, standards)
    const due = supportDueDate(support, tree, standards)
    let bucket: ScheduleBucket = 'upcoming'
    if (support.scheduledQuarter === current) {
      bucket = 'planned'
    } else if (due !== '' && due <= endOfQuarter) {
      // 本季到期（含超期、未排期、或此前排到未来季度但按新周期已提前到期）：一律进本季待检
      bucket = 'queued'
    } else if (support.scheduledQuarter !== '' && !isStaleQuarter(support.scheduledQuarter, current)) {
      // 本季不到期且已排入未来某季度（如顺延后预先占的批次）
      bucket = 'future'
    }
    return {
      support,
      tree,
      cycleMon,
      due,
      bucket,
      assignedQuarter: bucket === 'planned' || bucket === 'future' ? support.scheduledQuarter : '',
    }
  })

  // 已排入本季度的名额先占用容量（其余状态不占本季名额）
  const usedCapacity = entries.filter((entry) => entry.bucket === 'planned').length
  let slots = Math.max(0, cap - usedCapacity)

  // 待排期：到期日越早越优先（含从未检查 / 已超期），同日按安装日期、id 稳定排序
  const candidates = entries
    .filter((entry) => entry.bucket === 'queued')
    .sort((a, b) =>
      a.due.localeCompare(b.due) ||
      a.support.installDate.localeCompare(b.support.installDate) ||
      a.support.id.localeCompare(b.support.id)
    )

  const assignments: Array<{ id: string; quarter: string }> = []
  for (const entry of candidates) {
    if (slots > 0) {
      entry.bucket = 'planned'
      entry.assignedQuarter = current
      assignments.push({ id: entry.support.id, quarter: current })
      slots -= 1
    } else {
      // 容量不足：保持待检，顺延等下一批
      entry.bucket = 'queued'
      entry.assignedQuarter = ''
    }
  }

  return {
    entries,
    usedCapacity,
    capacity: cap,
    assignments,
    queuedCount: entries.filter((entry) => entry.bucket === 'queued').length,
  }
}

/** 已排入的季度是否早于当前季度（对账重算后理应不存在，留作兜底判定） */
export function isStaleQuarter(quarter: string, current: string): boolean {
  if (quarter === '') return false
  return quarterOrder(quarter) < quarterOrder(current)
}
