<script setup lang="ts">
/**
 * /inspections 加固件检查批次（巡检班上报 / 保护科对账）
 * - 巡检班：上门检查后按季度整批上报加固件检查条目（树体检查仍在「树体检查」页记录）；
 *   现场发现倾斜超限 / 空洞高风险不改加固件周期，只随树体检查跟踪；
 * - 保护科：整批校验，有一条不对就整批退回重报（台账不动）；回齐整批通过后对账，
 *   覆盖到的加固件按保护科周期 + 最新检查日期重算，原排期作废、重新进待检清单；
 *   巡检带回的保护级别仅留痕，一律以古树现档为准。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useTreeStore } from '@/stores/treeStore'
import { useSupportStore } from '@/stores/supportStore'
import type { InspectionBatch, InspectionItem } from '@/types/inspection'
import type { Support } from '@/types/support'
import type { BatchValidation } from '@/utils/inspection'
import { quarterLabel, quarterOptions } from '@/utils/quarter'
import { today, uuid } from '@/utils/id'

type TabKey = '待对账' | '已退回' | '已对账'

const treeStore = useTreeStore()
const supportStore = useSupportStore()

const activeTab = ref<TabKey>('待对账')
/** 展开的批次面板（待对账页默认全展开） */
const expandedNames = ref<string[]>([])

const tabBatches = computed<InspectionBatch[]>(() => {
  if (activeTab.value === '待对账') return supportStore.pendingBatches
  if (activeTab.value === '已退回') return supportStore.returnedBatches
  return supportStore.reconciledBatches
})

const totals = computed(() => ({
  pending: supportStore.pendingBatches.length,
  returned: supportStore.returnedBatches.length,
  done: supportStore.reconciledBatches.length,
  pendingItems: supportStore.pendingBatches.reduce((acc, row) => acc + row.items.length, 0),
}))

// 进入「待对账」时默认展开全部，其它页签默认收起，避免长列表
watch(
  [activeTab, tabBatches],
  () => {
    expandedNames.value = activeTab.value === '待对账' ? tabBatches.value.map((row) => row.id) : []
  },
  { immediate: true }
)

/* ------------------------------ 批次编辑（巡检班） ------------------------------ */

const dialogVisible = ref(false)
const submitting = ref(false)
const editingBatchId = ref<string | null>(null)
const formQuarter = ref(supportStore.currentQuarter)

interface FormLine {
  supportId: string
  type: string
  reportedLevel: string
  checkDate: string
  note: string
}
const formLines = ref<FormLine[]>([])

const treeMap = computed(() => Object.fromEntries(treeStore.trees.map((tree) => [tree.id, tree])))

function supportLabel(support: Support | undefined): string {
  if (!support) return '（台账中不存在）'
  const tree = treeMap.value[support.treeId]
  return `${tree ? `${tree.code} ${tree.species}` : '（古树已删除）'} · ${support.type}（${support.installDate} 装）`
}

function supportOf(id: string): Support | undefined {
  return supportStore.supports.find((row) => row.id === id)
}

/** 现档级别（对账唯一采信值） */
function currentLevelOf(supportId: string): string {
  const support = supportOf(supportId)
  return support ? (treeMap.value[support.treeId]?.protectLevel ?? '—') : '—'
}

function addLine(supportId = ''): void {
  const support = supportOf(supportId)
  formLines.value.push({
    supportId,
    type: support?.type ?? '支撑杆',
    reportedLevel: support ? (treeMap.value[support.treeId]?.protectLevel ?? '') : '',
    checkDate: today(),
    note: '',
  })
}

function removeLine(index: number): void {
  formLines.value.splice(index, 1)
}

/** 选择加固件后，自动带出类型与巡检现场记录的保护级别（仅留痕） */
function onPickSupport(line: FormLine): void {
  const support = supportOf(line.supportId)
  if (!support) return
  line.type = support.type
  if (line.reportedLevel === '') line.reportedLevel = treeMap.value[support.treeId]?.protectLevel ?? ''
}

function openCreate(): void {
  editingBatchId.value = null
  formQuarter.value = supportStore.currentQuarter
  formLines.value = []
  addLine()
  dialogVisible.value = true
}

function openResubmit(batch: InspectionBatch): void {
  editingBatchId.value = batch.id
  formQuarter.value = batch.quarter
  formLines.value = batch.items.map((item) => ({
    supportId: item.supportId,
    type: item.type,
    reportedLevel: item.reportedLevel,
    checkDate: item.checkDate,
    note: item.note,
  }))
  dialogVisible.value = true
}

/** 编辑中的批次实时校验（保护科视角） */
const draftValidation = computed<BatchValidation>(() => {
  const draftBatch: InspectionBatch = {
    id: 'draft',
    batchNo: 'draft',
    quarter: formQuarter.value,
    state: '待对账',
    items: formLines.value.map((line, index) => ({
      itemId: `draft-${index}`,
      supportId: line.supportId,
      type: line.type as InspectionItem['type'],
      reportedLevel: line.reportedLevel,
      checkDate: line.checkDate,
      note: line.note,
      check: '待校验',
      rejectReason: '',
    })),
    returnReason: '',
    reconciledAt: '',
    createdAt: '',
    updatedAt: '',
    revision: 0,
  }
  return supportStore.checkBatch(draftBatch)
})

function issuesOf(index: number): { errors: string[]; infos: string[] } {
  const result = draftValidation.value.perItem[index]
  if (!result) return { errors: [], infos: [] }
  return {
    errors: result.issues.filter((issue) => issue.level === 'error').map((issue) => issue.message),
    infos: result.issues.filter((issue) => issue.level === 'info').map((issue) => issue.message),
  }
}

async function handleSubmit(): Promise<void> {
  if (formLines.value.length === 0) {
    ElMessage.warning('至少填写一条加固件检查记录')
    return
  }
  if (formLines.value.some((line) => line.supportId === '')) {
    ElMessage.error('每行都要对应到加固件台账')
    return
  }
  if (!draftValidation.value.ok) {
    ElMessage.error(`自检发现 ${draftValidation.value.errorCount} 处问题，更正后再上报（有一条不对整批都会被退回）`)
    return
  }
  submitting.value = true
  try {
    const payload = {
      quarter: formQuarter.value,
      items: formLines.value.map((line) => ({
        supportId: line.supportId,
        type: line.type as InspectionItem['type'],
        reportedLevel: line.reportedLevel,
        checkDate: line.checkDate,
        note: line.note.trim(),
      })),
    }
    if (editingBatchId.value === null) {
      await supportStore.submitBatch(payload)
    } else {
      const items: InspectionItem[] = payload.items.map((item) => ({
        itemId: uuid('bi'),
        ...item,
        check: '待校验',
        rejectReason: '',
      }))
      await supportStore.resubmitBatch(editingBatchId.value, items)
    }
    ElMessage.success(supportStore.lastMessage)
    dialogVisible.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '上报失败')
  } finally {
    submitting.value = false
  }
}

/* ------------------------------ 对账（保护科） ------------------------------ */

const rejectDialogVisible = ref(false)
const rejectTarget = ref<InspectionBatch | null>(null)
const rejectReason = ref('')

function validationOf(batch: InspectionBatch): BatchValidation {
  return supportStore.checkBatch(batch)
}

function itemIssues(batch: InspectionBatch, index: number): { errors: string[]; infos: string[] } {
  const result = validationOf(batch).perItem[index]
  if (!result) return { errors: [], infos: [] }
  return {
    errors: result.issues.filter((issue) => issue.level === 'error').map((issue) => issue.message),
    infos: result.issues.filter((issue) => issue.level === 'info').map((issue) => issue.message),
  }
}

function openReject(batch: InspectionBatch): void {
  rejectTarget.value = batch
  rejectReason.value = batch.returnReason ?? ''
  rejectDialogVisible.value = true
}

async function confirmReject(): Promise<void> {
  if (!rejectTarget.value) return
  const validation = supportStore.checkBatch(rejectTarget.value)
  if (validation.ok) {
    ElMessage.info('该批次没有不合格条目，无需退回')
    rejectDialogVisible.value = false
    return
  }
  await supportStore.rejectBatch(rejectTarget.value.id, rejectReason.value, validation)
  ElMessage.success(supportStore.lastMessage)
  rejectDialogVisible.value = false
  activeTab.value = '已退回'
}

async function handleReconcile(batch: InspectionBatch): Promise<void> {
  const validation = supportStore.checkBatch(batch)
  if (!validation.ok) {
    ElMessage.error(`整批有 ${validation.errorCount} 处问题，不能对账，请整批退回重报`)
    return
  }
  try {
    await ElMessageBox.confirm(
      `整批校验通过。对账后 ${batch.items.length} 件加固件将按最新检查日期与保护科周期重算，原排期作废、重新进待检清单。`,
      '确认整批对账？',
      { type: 'warning', confirmButtonText: '确认对账', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  const count = await supportStore.reconcileBatch(batch.id, validation)
  ElMessage.success(`对账完成，已重算 ${count} 件加固件`)
}

async function handleDeleteBatch(batch: InspectionBatch): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认删除批次 ${batch.batchNo}？该操作只影响检查批次记录，不动加固件台账。`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  await supportStore.deleteBatch(batch.id)
  ElMessage.success('批次已删除')
}

onMounted(() => {
  void treeStore.loadAll()
  void supportStore.loadAll()
})
</script>

<template>
  <div>
    <div class="stat-row">
      <StatBadge label="待对账批次" :value="totals.pending" suffix="批" tone="warning" icon="Histogram" />
      <StatBadge label="待对账条目" :value="totals.pendingItems" suffix="条" tone="primary" icon="Files" />
      <StatBadge label="已退回重报" :value="totals.returned" suffix="批" tone="danger" icon="RefreshLeft" />
      <StatBadge label="已对账批次" :value="totals.done" suffix="批" tone="success" icon="CircleCheck" />
    </div>

    <el-alert
      type="info"
      show-icon
      :closable="false"
      class="mb-14"
      title="两侧职责分开：巡检班记录树体检查、按批上报加固件检查；保护科管台账、周期标准与对账结论。"
      description="交回的批次有一条不对就整批退回重报（保护科台账不动），回齐整批通过后再对账；对账以古树现档保护级别为准，巡检带回的旧级别只提示不采信。"
    />

    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">加固件检查批次</span>
          <el-button type="primary" @click="openCreate" :disabled="supportStore.supports.length === 0">
            <el-icon><Plus /></el-icon>
            <span>巡检上报一批检查</span>
          </el-button>
        </div>
      </template>

      <el-tabs v-model="activeTab">
        <el-tab-pane :label="`待对账（${totals.pending}）`" name="待对账" />
        <el-tab-pane :label="`已退回（${totals.returned}）`" name="已退回" />
        <el-tab-pane :label="`已对账（${totals.done}）`" name="已对账" />
      </el-tabs>

      <EmptyPanel
        v-if="tabBatches.length === 0"
        :title="activeTab === '已退回' ? '没有被退回的批次' : activeTab === '已对账' ? '还没有对账完成的批次' : '还没有待对账批次'"
        :description="
          activeTab === '待对账'
            ? '巡检班上门检查后，把加固件检查结果按季度整批上报；保护科整批校验，通过后对账并重算排期。'
            : '可切换页签查看其它状态的批次。'
        "
        :action-text="activeTab === '待对账' ? '上报一批检查' : ''"
        @action="activeTab === '待对账' ? openCreate() : undefined"
      />

      <el-collapse v-else v-model="expandedNames">
        <el-collapse-item v-for="batch in tabBatches" :key="batch.id" :name="batch.id">
          <template #title>
            <div class="batch-title">
              <el-tag
                :type="batch.state === '已对账' ? 'success' : batch.state === '已退回' ? 'danger' : 'warning'"
                size="small"
                effect="dark"
              >
                {{ batch.state }}
              </el-tag>
              <span class="batch-no">{{ batch.batchNo }}</span>
              <span class="batch-quarter">{{ quarterLabel(batch.quarter) }}</span>
              <span class="batch-count">{{ batch.items.length }} 条</span>
              <el-tag
                v-if="batch.state === '待对账'"
                :type="validationOf(batch).ok ? 'success' : 'danger'"
                size="small"
                effect="plain"
              >
                {{ validationOf(batch).ok ? '整批校验通过' : `校验 ${validationOf(batch).errorCount} 处问题` }}
              </el-tag>
            </div>
          </template>

          <el-alert
            v-if="batch.returnReason !== ''"
            type="error"
            show-icon
            :closable="false"
            class="mb-10"
            :title="`退回原因：${batch.returnReason}`"
          />

          <el-table :data="batch.items" size="small" border>
            <el-table-column label="加固件" min-width="230">
              <template #default="{ row }">
                <div class="cell-stack">
                  <span>{{ supportLabel(supportOf(row.supportId)) }}</span>
                  <span class="cell-sub">类型：{{ row.type }}</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="检查日期" width="120">
              <template #default="{ row }">{{ row.checkDate }}</template>
            </el-table-column>
            <el-table-column label="巡检带回级别" width="120">
              <template #default="{ row }">
                <el-tag size="small" type="info" effect="plain">{{ row.reportedLevel || '未填' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="现档级别" width="100">
              <template #default="{ row }">
                <el-tag size="small" :type="currentLevelOf(row.supportId) === '一级' ? 'danger' : 'warning'">
                  {{ currentLevelOf(row.supportId) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="现场情况" min-width="220">
              <template #default="{ row }">
                <span>{{ row.note }}</span>
              </template>
            </el-table-column>
            <el-table-column label="保护科校验" min-width="240">
              <template #default="{ row, $index }">
                <div class="issue-box">
                  <el-tag
                    v-if="itemIssues(batch, $index).errors.length > 0"
                    type="danger"
                    size="small"
                    effect="dark"
                  >
                    不通过
                  </el-tag>
                  <el-tag v-else-if="batch.state === '已对账' || row.check === '通过'" type="success" size="small">
                    通过
                  </el-tag>
                  <el-tag v-else type="info" size="small" effect="plain">待校验</el-tag>
                  <span v-for="(msg, i) in itemIssues(batch, $index).errors" :key="`e-${i}`" class="issue issue--error">
                    {{ msg }}
                  </span>
                  <span v-for="(msg, i) in itemIssues(batch, $index).infos" :key="`i-${i}`" class="issue issue--info">
                    {{ msg }}
                  </span>
                  <span v-if="row.rejectReason" class="issue issue--error">登记原因：{{ row.rejectReason }}</span>
                </div>
              </template>
            </el-table-column>
          </el-table>

          <div class="batch-actions">
            <template v-if="batch.state === '待对账'">
              <el-button size="small" type="danger" plain @click="openReject(batch)">整批退回重报</el-button>
              <el-button
                size="small"
                type="success"
                :disabled="!validationOf(batch).ok"
                @click="handleReconcile(batch)"
              >
                整批通过并对账
              </el-button>
            </template>
            <el-button v-if="batch.state === '已退回'" size="small" type="primary" @click="openResubmit(batch)">
              更正后整批重报
            </el-button>
            <el-button size="small" @click="handleDeleteBatch(batch)">删除批次</el-button>
            <span v-if="batch.state === '已对账'" class="cell-sub">
              对账完成于 {{ batch.reconciledAt ? batch.reconciledAt.slice(0, 10) : '—' }}，覆盖件已按最新检查日期重算
            </span>
          </div>
        </el-collapse-item>
      </el-collapse>
    </el-card>

    <!-- 巡检班：上报 / 重报批次 -->
    <el-dialog
      v-model="dialogVisible"
      :title="editingBatchId === null ? '巡检上报加固件检查批次' : '退回批次整批重报'"
      width="900px"
      top="6vh"
    >
      <el-form label-width="110px">
        <el-form-item label="检查季度">
          <el-select v-model="formQuarter" style="width: 220px">
            <el-option v-for="q in quarterOptions()" :key="q" :value="q" :label="quarterLabel(q)" />
          </el-select>
          <span class="cell-sub ml-10">一批内任一条不合格，整批都会被退回重报</span>
        </el-form-item>
      </el-form>

      <el-alert
        :type="draftValidation.ok ? 'success' : 'error'"
        show-icon
        :closable="false"
        class="mb-10"
        :title="
          draftValidation.ok
            ? '整批自检通过，可以上报'
            : `自检发现 ${draftValidation.errorCount} 处问题，必须全部更正后才能上报`
        "
      />

      <el-table :data="formLines" size="small" border>
        <el-table-column type="index" label="#" width="44" />
        <el-table-column label="加固件（台账）" min-width="230">
          <template #default="{ row }">
            <el-select v-model="row.supportId" filterable size="small" style="width: 100%" @change="onPickSupport(row)">
              <el-option
                v-for="support in supportStore.supports"
                :key="support.id"
                :value="support.id"
                :label="supportLabel(support)"
              />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="检查日期" width="150">
          <template #default="{ row }">
            <el-date-picker v-model="row.checkDate" type="date" value-format="YYYY-MM-DD" size="small" style="width: 100%" />
          </template>
        </el-table-column>
        <el-table-column label="巡检带回级别" width="120">
          <template #default="{ row }">
            <el-select v-model="row.reportedLevel" size="small" style="width: 100%">
              <el-option v-for="lvl in ['一级', '二级', '三级']" :key="lvl" :value="lvl" :label="lvl" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="现场情况" min-width="220">
          <template #default="{ row }">
            <el-input v-model="row.note" size="small" type="textarea" :rows="2" placeholder="螺栓 / 锈蚀 / 接地 / 张力等检查情况" />
          </template>
        </el-table-column>
        <el-table-column label="自检" min-width="200">
          <template #default="{ $index }">
            <div class="issue-box">
              <el-tag v-if="issuesOf($index).errors.length === 0" type="success" size="small">通过</el-tag>
              <span v-for="(msg, i) in issuesOf($index).errors" :key="i" class="issue issue--error">{{ msg }}</span>
              <span v-for="(msg, i) in issuesOf($index).infos" :key="`info-${i}`" class="issue issue--info">{{ msg }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="70">
          <template #default="{ $index }">
            <el-button link type="danger" size="small" @click="removeLine($index)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="line-actions">
        <el-button size="small" @click="addLine()">
          <el-icon><Plus /></el-icon>
          <span>加一条</span>
        </el-button>
        <span class="cell-sub">倾斜超限 / 空洞高风险请到「树体检查」记录，不会改变加固件检查周期。</span>
      </div>

      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="handleSubmit">
          {{ editingBatchId === null ? '整批上报' : '整批重新上报' }}
        </el-button>
      </template>
    </el-dialog>

    <!-- 保护科：整批退回 -->
    <el-dialog v-model="rejectDialogVisible" title="整批退回重报（保护科台账不动）" width="560px">
      <el-alert
        type="error"
        show-icon
        :closable="false"
        class="mb-10"
        :title="rejectTarget ? `批次 ${rejectTarget.batchNo} 存在 ${supportStore.checkBatch(rejectTarget).errorCount} 处不合格条目，整批退回` : ''"
      />
      <el-input v-model="rejectReason" type="textarea" :rows="3" placeholder="填写退回原因，巡检班更正后整批重新上报" />
      <template #footer>
        <el-button @click="rejectDialogVisible = false">取消</el-button>
        <el-button type="danger" :disabled="!rejectTarget || supportStore.checkBatch(rejectTarget).ok" @click="confirmReject">
          确认整批退回
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.stat-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 14px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.card-header__title {
  font-size: 15px;
  font-weight: 600;
  color: #2f2a24;
}

.batch-title {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.batch-no {
  font-weight: 600;
  color: #2f2a24;
}

.batch-quarter,
.batch-count {
  font-size: 12px;
  color: #8c8479;
}

.batch-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
  flex-wrap: wrap;
}

.cell-stack {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.cell-sub {
  font-size: 12px;
  color: #8c8479;
}

.ml-10 {
  margin-left: 10px;
}

.issue-box {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.issue {
  font-size: 12px;
  line-height: 1.5;
}

.issue--error {
  color: #c0392b;
}

.issue--info {
  color: #b8860b;
}

.line-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 10px;
  flex-wrap: wrap;
}

.mb-10 {
  margin-bottom: 10px;
}

.mb-14 {
  margin-bottom: 14px;
}
</style>
