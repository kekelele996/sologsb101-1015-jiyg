/**
 * 保护科台账状态管理（Pinia）
 * 周期标准（保护级别 → 周期月数）、每季度检查容量、加固件待检队列；
 * 数据全部来自 treeStore 的 liveQuery 订阅，本 store 只负责写入与重排动作。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { ProtectLevel } from '../types/tree'
import type { CycleStandard } from '../types/cycle'
import { DEFAULT_QUARTER_CAPACITY } from '../types/cycle'
import type { SupportCheckPlan } from '../types/plan'
import {
  getQuarterCapacity,
  markPlanChecked,
  putCycleStandard,
  rebuildPendingPlans,
  setQuarterCapacity,
} from '../utils/db'
import { cycleMonthsOf } from '../utils/cycle'
import { today } from '../utils/id'
import { useTreeStore } from './treeStore'

export const useCycleStore = defineStore('cycle', () => {
  const treeStore = useTreeStore()
  const capacity = ref(DEFAULT_QUARTER_CAPACITY)
  const loaded = ref(false)
  const saving = ref(false)

  /** 各级别生效周期（缺档回退默认值） */
  const cycleOfLevel = computed(() => (level: ProtectLevel): number =>
    cycleMonthsOf(level, treeStore.cycleStandards),
  )

  /** 待检计划（仅待检状态），按季度、到期日排序 */
  const pendingPlans = computed<SupportCheckPlan[]>(() =>
    treeStore.plans
      .filter((plan) => plan.status === '待检')
      .sort((a, b) => a.quarter.localeCompare(b.quarter) || a.dueDate.localeCompare(b.dueDate)),
  )

  /** 已查历史（冻结，查完的不再改） */
  const checkedPlans = computed<SupportCheckPlan[]>(() =>
    treeStore.plans
      .filter((plan) => plan.status === '已查')
      .sort((a, b) => b.checkedDate.localeCompare(a.checkedDate)),
  )

  const voidedPlans = computed<SupportCheckPlan[]>(() =>
    treeStore.plans.filter((plan) => plan.status === '已作废'),
  )

  /** 按季度聚合待检数量 */
  const pendingByQuarter = computed<Record<string, SupportCheckPlan[]>>(() => {
    const result: Record<string, SupportCheckPlan[]> = {}
    pendingPlans.value.forEach((plan) => {
      ;(result[plan.quarter] ??= []).push(plan)
    })
    return result
  })

  async function loadSettings(): Promise<void> {
    capacity.value = await getQuarterCapacity()
    loaded.value = true
  }

  async function saveStandard(level: ProtectLevel, months: number): Promise<void> {
    saving.value = true
    try {
      await putCycleStandard(level, months)
      // 周期标准变更后待检队列按新标准重排；已查历史不动
      await rebuildPendingPlans()
    } finally {
      saving.value = false
    }
  }

  async function saveCapacity(value: number): Promise<void> {
    saving.value = true
    try {
      capacity.value = value
      await setQuarterCapacity(value)
      await rebuildPendingPlans()
    } finally {
      saving.value = false
    }
  }

  /** 手动触发一次重排（保护科） */
  async function repack(): Promise<number> {
    saving.value = true
    try {
      const plans = await rebuildPendingPlans()
      return plans.length
    } finally {
      saving.value = false
    }
  }

  /** 登记某条待检计划本季度已检查（查完冻结并重排） */
  async function checkPlan(planId: string, date = today()): Promise<void> {
    await markPlanChecked(planId, date)
  }

  /** 取某级别的标准行（编辑回显用） */
  function standardRow(level: ProtectLevel): CycleStandard | undefined {
    return treeStore.cycleStandards.find((row) => row.id === level)
  }

  return {
    capacity,
    loaded,
    saving,
    cycleOfLevel,
    pendingPlans,
    checkedPlans,
    voidedPlans,
    pendingByQuarter,
    loadSettings,
    saveStandard,
    saveCapacity,
    repack,
    checkPlan,
    standardRow,
  }
})
