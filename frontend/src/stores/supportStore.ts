/**
 * 加固件与检查批次状态管理（Pinia）
 * 两侧职责严格分开：
 * - 巡检班：树体检查（surveyStore 之外的 Survey 页面）与「检查批次」的上报、退回后整批重报；
 * - 保护科：加固件台账、按保护级别的周期标准、每季度检查容量、季度排期、批次对账与长势复评结论。
 *
 * 校验规则：交回的批次有一条不对就整批退回重报（台账不动）；回齐整批通过后才对账，
 * 覆盖到的加固件按保护科周期 + 最新检查日期重算、原排期作废重新进待检清单；
 * 巡检带回的保护级别一律不采信，以古树现档为准。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { liveQuery } from 'dexie'
import type { Support, SupportDraft } from '../types/support'
import type { CycleStandard, CycleTier } from '../types/cycle'
import type {
  BatchState,
  InspectionBatch,
  InspectionItem,
} from '../types/inspection'
import {
  db,
  ROW_REVISION,
  applyScheduleAssignments,
  getSetting,
  listCycleStandards,
  putBatch,
  putSupport,
  removeSupport,
  updateCycleStandard,
  updateQuarterCapacity,
} from '../utils/db'
import {
  buildSchedule,
  effectiveCycleMon,
  isSupportOverdueEffective,
  supportDueDate,
  type SchedulePlan,
} from '../utils/scheduling'
import { buildReconcilePatches, validateBatch, type BatchValidation } from '../utils/inspection'
import { currentQuarter } from '../utils/quarter'
import { nowIso, today, uuid } from '../utils/id'
import { useTreeStore } from './treeStore'

let subscribed = false

function blankItem(): InspectionItem {
  return {
    itemId: '',
    supportId: '',
    type: '支撑杆',
    reportedLevel: '',
    checkDate: today(),
    note: '',
    check: '待校验',
    rejectReason: '',
  }
}

export const useSupportStore = defineStore('support', () => {
  const supports = ref<Support[]>([])
  const standards = ref<CycleStandard[]>([])
  const batches = ref<InspectionBatch[]>([])
  const quarterCapacity = ref(0)
  const ready = ref(false)
  const currentQ = ref(currentQuarter())
  const lastMessage = ref('')

  const standardMap = computed<Record<string, number>>(() =>
    Object.fromEntries(standards.value.map((row) => [row.id, row.checkCycleMon]))
  )

  /** 周期标准档位（供下拉 / 表格使用） */
  const tierOptions = computed<CycleTier[]>(() => standards.value.map((row) => row.id))

  function treeOf(support: Support) {
    return useTreeStore().trees.find((tree) => tree.id === support.treeId) ?? null
  }

  /** 某件加固件的有效周期（现档级别 → 周期标准） */
  function cycleOf(support: Support): number {
    return effectiveCycleMon(support, treeOf(support), standards.value)
  }

  /** 某件加固件下次应检查日期 */
  function dueOf(support: Support): string {
    return supportDueDate(support, treeOf(support), standards.value)
  }

  function isOverdue(support: Support): boolean {
    return isSupportOverdueEffective(support, treeOf(support), standards.value)
  }

  /** 当前季度的排期方案（待检清单 / 已排入 / 排队 / 未到期） */
  const schedule = computed<SchedulePlan>(() =>
    buildSchedule(
      supports.value,
      useTreeStore().trees,
      standards.value,
      currentQ.value,
      quarterCapacity.value
    )
  )

  const pendingBatches = computed<InspectionBatch[]>(() =>
    batches.value.filter((row) => row.state === '待对账')
  )
  const returnedBatches = computed<InspectionBatch[]>(() =>
    batches.value.filter((row) => row.state === '已退回')
  )
  const reconciledBatches = computed<InspectionBatch[]>(() =>
    batches.value.filter((row) => row.state === '已对账')
  )

  /** 超期加固件（按有效周期） */
  const overdueSupports = computed<Support[]>(() => supports.value.filter((row) => isOverdue(row)))

  async function loadAll(): Promise<void> {
    if (!subscribed) {
      subscribed = true
      liveQuery(() => db.supports.toArray()).subscribe({
        next: (rows) => {
          supports.value = rows
          ready.value = true
        },
        error: () => undefined,
      })
      liveQuery(() => listCycleStandards()).subscribe({
        next: (rows) => {
          standards.value = rows
        },
        error: () => undefined,
      })
      liveQuery(() => db.inspectionBatches.toArray()).subscribe({
        next: (rows) => {
          batches.value = rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        },
        error: () => undefined,
      })
    }
    const setting = await getSetting()
    quarterCapacity.value = setting.quarterCapacity
    currentQ.value = currentQuarter()
  }

  /* ------------------------------ 加固件台账（保护科） ------------------------------ */

  async function createSupport(draft: SupportDraft): Promise<Support> {
    const stamp = nowIso()
    const tree = useTreeStore().trees.find((row) => row.id === draft.treeId)
    // 周期不由手填决定：新建即按现档级别对应的周期标准定档
    const cycle = tree ? standardMap.value[tree.protectLevel] : draft.checkCycleMon
    const row: Support = {
      id: uuid('support'),
      treeId: draft.treeId,
      type: draft.type,
      installDate: draft.installDate,
      checkCycleMon: cycle ?? draft.checkCycleMon,
      lastCheckDate: draft.lastCheckDate,
      scheduledQuarter: '',
      reconciledAt: '',
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }
    await putSupport(row)
    return row
  }

  async function updateSupport(id: string, draft: SupportDraft): Promise<void> {
    const existing = await db.supports.get(id)
    if (!existing) return
    const tree = useTreeStore().trees.find((row) => row.id === draft.treeId)
    const cycle = tree ? standardMap.value[tree.protectLevel] : draft.checkCycleMon
    await putSupport({
      ...existing,
      treeId: draft.treeId,
      type: draft.type,
      installDate: draft.installDate,
      checkCycleMon: cycle ?? draft.checkCycleMon,
      lastCheckDate: draft.lastCheckDate,
    })
  }

  async function deleteSupport(id: string): Promise<void> {
    await removeSupport(id)
  }

  /** 按当前季度容量把待检件排入批次（排不完的继续排队等下一批） */
  async function runScheduling(): Promise<number> {
    const plan = buildSchedule(
      supports.value,
      useTreeStore().trees,
      standards.value,
      currentQ.value,
      quarterCapacity.value
    )
    await applyScheduleAssignments(plan.assignments)
    lastMessage.value =
      plan.assignments.length > 0
        ? `已把 ${plan.assignments.length} 件排入${currentQ.value}，${plan.queuedCount} 件排队等下一批`
        : '本季度名额已排满或没有到期件'
    return plan.assignments.length
  }

  /** 推进到下一季度并重新排期（把上季未查 / 新到期的件顺延入队） */
  function rollToNextQuarter(): void {
    const order = ['Q1', 'Q2', 'Q3', 'Q4'] as const
    const year = Number(currentQ.value.slice(0, 4))
    const q = currentQ.value.slice(4)
    const idx = order.indexOf(q as (typeof order)[number])
    currentQ.value = idx === 3 ? `${year + 1}Q1` : `${year}${order[idx + 1]}`
  }

  async function saveCycle(tier: CycleTier, checkCycleMon: number): Promise<void> {
    await updateCycleStandard(tier, checkCycleMon)
    lastMessage.value = `${tier}古树加固件检查周期更新为 ${checkCycleMon} 个月（已查完的不再改）`
  }

  async function saveCapacity(value: number): Promise<void> {
    await updateQuarterCapacity(value)
    quarterCapacity.value = Math.max(0, Math.floor(value))
    lastMessage.value = `每季度检查容量已调整为 ${quarterCapacity.value} 件`
  }

  /* ------------------------------ 检查批次（巡检班上报） ------------------------------ */

  /** 巡检班新建并上报一批检查记录（初始状态：待对账） */
  async function submitBatch(input: {
    quarter: string
    items: Array<Pick<InspectionItem, 'supportId' | 'type' | 'reportedLevel' | 'checkDate' | 'note'>>
  }): Promise<InspectionBatch> {
    const stamp = nowIso()
    const items: InspectionItem[] = input.items.map((item) => ({
      ...blankItem(),
      ...item,
      itemId: uuid('bi'),
    }))
    const sameQuarter = batches.value.filter((row) => row.quarter === input.quarter).length + 1
    const row: InspectionBatch = {
      id: uuid('batch'),
      batchNo: `${input.quarter.replace('Q', '-Q')}-${String(sameQuarter).padStart(2, '0')}`,
      quarter: input.quarter,
      state: '待对账',
      items,
      returnReason: '',
      reconciledAt: '',
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }
    await putBatch(row)
    lastMessage.value = `批次 ${row.batchNo} 已上报，等待保护科对账`
    return row
  }

  /** 退回后整批重报：用更正后的条目覆盖原批次，状态回到「待对账」 */
  async function resubmitBatch(batchId: string, items: InspectionItem[]): Promise<void> {
    const existing = await db.inspectionBatches.get(batchId)
    if (!existing) return
    const stamp = nowIso()
    const nextItems: InspectionItem[] = items.map((item) => ({
      ...item,
      itemId: item.itemId || uuid('bi'),
      check: '待校验',
      rejectReason: '',
    }))
    await putBatch({
      ...existing,
      items: nextItems,
      state: '待对账',
      returnReason: '',
      updatedAt: stamp,
    })
    lastMessage.value = `批次 ${existing.batchNo} 已重新上报，等待保护科对账`
  }

  async function deleteBatch(batchId: string): Promise<void> {
    await db.inspectionBatches.delete(batchId)
  }

  /* ------------------------------ 对账（保护科） ------------------------------ */

  /** 整批校验；任一条不通过即不合格 */
  function checkBatch(batch: InspectionBatch): BatchValidation {
    const treeStore = useTreeStore()
    return validateBatch(batch, supports.value, treeStore.trees, today())
  }

  /**
   * 整批退回：有一条不对即整批退回重报；保护科台账不动。
   */
  async function rejectBatch(batchId: string, reason: string, validation: BatchValidation): Promise<void> {
    const existing = await db.inspectionBatches.get(batchId)
    if (!existing) return
    const stamp = nowIso()
    const items: InspectionItem[] = existing.items.map((item, index) => {
      const result = validation.perItem[index]
      const errors = result.issues.filter((issue) => issue.level === 'error')
      return {
        ...item,
        check: errors.length > 0 ? '不通过' : '待校验',
        rejectReason: errors.map((issue) => issue.message).join('；'),
      }
    })
    await putBatch({
      ...existing,
      items,
      state: '已退回',
      returnReason: reason.trim() || '存在不合格条目，整批退回重报',
      updatedAt: stamp,
    })
    lastMessage.value = `批次 ${existing.batchNo} 已整批退回，保护科台账未改动`
  }

  /**
   * 整批通过后对账：覆盖到的加固件按保护科周期 + 最新检查日期重算，
   * 原排期作废（清空 scheduledQuarter）重新进待检清单。
   */
  async function reconcileBatch(batchId: string, validation: BatchValidation): Promise<number> {
    const existing = await db.inspectionBatches.get(batchId)
    if (!existing || !validation.ok) return 0
    const stamp = nowIso()
    const patches = buildReconcilePatches(existing, stamp)
    await db.transaction('rw', db.supports, db.inspectionBatches, async () => {
      for (const patch of patches) {
        await db.supports.update(patch.id, {
          lastCheckDate: patch.lastCheckDate,
          scheduledQuarter: '',
          reconciledAt: stamp,
          updatedAt: stamp,
        })
      }
      const items: InspectionItem[] = existing.items.map((item) => ({
        ...item,
        check: '通过' as const,
        rejectReason: '',
      }))
      await db.inspectionBatches.put({
        ...existing,
        items,
        state: '已对账' as BatchState,
        returnReason: '',
        reconciledAt: stamp,
        updatedAt: stamp,
        revision: ROW_REVISION,
      })
    })
    lastMessage.value = `对账完成：${patches.length} 件加固件已按最新检查日期重算并入待检清单`
    return patches.length
  }

  return {
    // state
    supports,
    standards,
    batches,
    quarterCapacity,
    ready,
    currentQuarter: currentQ,
    lastMessage,
    // getters
    tierOptions,
    schedule,
    pendingBatches,
    returnedBatches,
    reconciledBatches,
    overdueSupports,
    // helpers
    cycleOf,
    dueOf,
    isOverdue,
    // actions
    loadAll,
    createSupport,
    updateSupport,
    deleteSupport,
    runScheduling,
    rollToNextQuarter,
    saveCycle,
    saveCapacity,
    submitBatch,
    resubmitBatch,
    deleteBatch,
    checkBatch,
    rejectBatch,
    reconcileBatch,
  }
})
