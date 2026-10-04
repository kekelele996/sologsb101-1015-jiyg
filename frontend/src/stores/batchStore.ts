/**
 * 树体检查批次状态管理（Pinia）
 * 巡检班：编批次、加入未交回检查记录、交回（交齐才允许）、被退回后改记录重报；
 * 保护科：核对已交回批次，有一条不对即整批退回（台账侧不动），交齐无误后对账，
 * 由对账事务按保护科周期重算覆盖加固件并重排待检清单。
 */
import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import type { SurveyBatch, SurveyBatchDraft, BatchStatus } from '../types/batch'
import type { Survey } from '../types/survey'
import {
  attachSurveysToBatch,
  detachSurveyFromBatch,
  getBatch,
  putBatch,
  reconcileBatch,
  removeBatch,
  returnBatch,
  submitBatch,
} from '../utils/db'
import { nowIso, uuid } from '../utils/id'
import { useTreeStore } from './treeStore'

export interface BatchFilters {
  keyword: string
  status: BatchStatus | 'all'
}

export const useBatchStore = defineStore('surveyBatch', () => {
  const treeStore = useTreeStore()
  const filters = reactive<BatchFilters>({ keyword: '', status: 'all' })
  const lastMessage = ref('')
  const working = ref(false)

  const visibleBatches = computed<SurveyBatch[]>(() => {
    const key = filters.keyword.trim().toLowerCase()
    return treeStore.batches
      .filter((batch) => {
        if (filters.status !== 'all' && batch.status !== filters.status) return false
        if (key === '') return true
        return batch.name.toLowerCase().includes(key)
      })
      .sort((a, b) => b.visitDate.localeCompare(a.visitDate))
  })

  /** 可编入新批次的检查记录：未交回（batchId 为空） */
  const unassignedSurveys = computed<Survey[]>(() =>
    treeStore.surveys
      .filter((row) => row.batchId === '')
      .sort((a, b) => b.date.localeCompare(a.date)),
  )

  function surveysOfBatch(batchId: string): Survey[] {
    const batch = treeStore.batches.find((row) => row.id === batchId)
    if (!batch) return []
    return treeStore.surveys
      .filter((row) => batch.surveyIds.includes(row.id))
      .sort((a, b) => a.date.localeCompare(b.date))
  }

  function setFilters(patch: Partial<BatchFilters>): void {
    Object.assign(filters, patch)
  }

  function resetFilters(): void {
    filters.keyword = ''
    filters.status = 'all'
  }

  async function createBatch(draft: SurveyBatchDraft): Promise<SurveyBatch> {
    const stamp = nowIso()
    const row: SurveyBatch = {
      id: uuid('batch'),
      name: draft.name.trim() || '未命名巡检批次',
      visitDate: draft.visitDate,
      plannedCount: draft.plannedCount,
      surveyIds: [],
      status: '草稿',
      levelSnapshot: {},
      returnReason: '',
      submittedAt: '',
      reconciledAt: '',
      createdAt: stamp,
      updatedAt: stamp,
      revision: 3,
    }
    await putBatch(row)
    lastMessage.value = `已建立批次「${row.name}」，可加入本批检查记录`
    return row
  }

  async function updateBatch(batchId: string, patch: Partial<SurveyBatchDraft>): Promise<void> {
    const existing = await getBatch(batchId)
    if (!existing) return
    await putBatch({
      ...existing,
      name: patch.name !== undefined ? (patch.name.trim() || existing.name) : existing.name,
      visitDate: patch.visitDate ?? existing.visitDate,
      plannedCount: patch.plannedCount ?? existing.plannedCount,
    })
  }

  async function addSurveys(batchId: string, surveyIds: string[]): Promise<void> {
    await attachSurveysToBatch(batchId, surveyIds)
    lastMessage.value = `已加入 ${surveyIds.length} 条检查记录`
  }

  async function removeSurvey(batchId: string, surveyId: string): Promise<void> {
    await detachSurveyFromBatch(batchId, surveyId)
  }

  async function deleteBatch(batchId: string): Promise<void> {
    await removeBatch(batchId)
    lastMessage.value = '批次已删除，明细记录回到未交回'
  }

  async function submit(batchId: string): Promise<void> {
    working.value = true
    try {
      await submitBatch(batchId)
      lastMessage.value = '批次已交回保护科核对，明细记录已锁定'
    } finally {
      working.value = false
    }
  }

  async function sendBack(batchId: string, reason: string): Promise<void> {
    working.value = true
    try {
      await returnBatch(batchId, reason)
      lastMessage.value = '发现有误，已整批退回（保护科台账未改动），等待巡检班重报'
    } finally {
      working.value = false
    }
  }

  async function reconcile(batchId: string): Promise<{ supports: number; trees: number; plans: number }> {
    working.value = true
    try {
      const result = await reconcileBatch(batchId)
      lastMessage.value = `对账完成：覆盖 ${result.coveredTreeIds.length} 株古树、${result.updatedSupportIds.length} 件加固件，待检队列已按保护科周期重排`
      return {
        trees: result.coveredTreeIds.length,
        supports: result.updatedSupportIds.length,
        plans: result.repacked.length,
      }
    } finally {
      working.value = false
    }
  }

  return {
    filters,
    lastMessage,
    working,
    visibleBatches,
    unassignedSurveys,
    surveysOfBatch,
    setFilters,
    resetFilters,
    createBatch,
    updateBatch,
    addSurveys,
    removeSurvey,
    deleteBatch,
    submit,
    sendBack,
    reconcile,
  }
})
