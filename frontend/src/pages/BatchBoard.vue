<script setup lang="ts">
/**
 * /batches 树体检查批次（巡检班 ↔ 保护科 的交回 / 退回 / 对账）
 * - 巡检班：建批次、加入未交回检查记录、交齐后交回；被整批退回后修正记录再重报；
 * - 保护科：核对已交回批次；有一条不对就整批退回（台账侧不动）；交齐无误后对账，
 *   覆盖到的加固件按现档保护级别 + 周期标准、以批次内最新检查日期重算，原待检计划作废并重排。
 * 巡检带回的旧保护级别只作对照，级别以古树现档为准。
 * 消费模型：SurveyBatch、Survey、Tree、Support；复用组件：<StatBadge>、<EmptyPanel>
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useTreeStore } from '@/stores/treeStore'
import { useBatchStore, type BatchFilters } from '@/stores/batchStore'
import { useRoleStore } from '@/stores/roleStore'
import type { SurveyBatch, BatchStatus, SurveyBatchDraft } from '@/types/batch'
import { BATCH_STATUS_OPTIONS } from '@/types/batch'
import type { Survey } from '@/types/survey'
import { today } from '@/utils/id'
import { LEAN_DANGER_DEG } from '@/utils/dimension'

const treeStore = useTreeStore()
const batchStore = useBatchStore()
const roleStore = useRoleStore()

const statusFilter = ref<BatchFilters['status']>('all')
const keyword = ref('')

const createVisible = ref(false)
const detailId = ref<string | null>(null)
const formRef = ref<FormInstance>()
const submitting = ref(false)

const createForm = reactive<SurveyBatchDraft>({
  name: '',
  visitDate: today(),
  plannedCount: 1,
})

const createRules: FormRules<SurveyBatchDraft> = {
  name: [{ required: true, message: '请填写批次名称', trigger: 'blur' }],
  visitDate: [{ required: true, message: '请选择上门日期', trigger: 'change' }],
  plannedCount: [{ required: true, message: '请填写计划检查株数', trigger: 'blur' }],
}

/** 加入批次弹窗 */
const attachVisible = ref(false)
const attachTargetId = ref<string | null>(null)
const attachSelected = ref<string[]>([])

/** 整批退回弹窗 */
const returnVisible = ref(false)
const returnTargetId = ref<string | null>(null)
const returnReason = ref('')

const treeLabel = computed<Record<string, string>>(() =>
  Object.fromEntries(treeStore.trees.map((tree) => [tree.id, `${tree.code} ${tree.species}`]))
)

const filteredBatches = computed<SurveyBatch[]>(() => {
  const key = keyword.value.trim().toLowerCase()
  return batchStore.visibleBatches
    .filter((batch) => {
      if (statusFilter.value !== 'all' && batch.status !== statusFilter.value) return false
      if (key === '') return true
      return batch.name.toLowerCase().includes(key)
    })
})

const statusCount = computed<Record<BatchStatus, number>>(() => {
  const result: Record<BatchStatus, number> = { 草稿: 0, 已交回: 0, 已退回: 0, 已对账: 0 }
  treeStore.batches.forEach((batch) => {
    result[batch.status] += 1
  })
  return result
})

const currentBatch = computed<SurveyBatch | null>(() =>
  detailId.value === null ? null : treeStore.batches.find((batch) => batch.id === detailId.value) ?? null
)

const currentSurveys = computed<Survey[]>(() =>
  currentBatch.value === null ? [] : batchStore.surveysOfBatch(currentBatch.value.id)
)

onMounted(() => {
  void treeStore.loadAll()
})

function statusTagType(status: BatchStatus): 'info' | 'warning' | 'danger' | 'success' {
  if (status === '草稿') return 'info'
  if (status === '已交回') return 'warning'
  if (status === '已退回') return 'danger'
  return 'success'
}

function openCreate(): void {
  Object.assign(createForm, { name: '', visitDate: today(), plannedCount: 1 })
  createVisible.value = true
}

async function handleCreate(): Promise<void> {
  if (formRef.value === undefined) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  submitting.value = true
  try {
    const batch = await batchStore.createBatch({ ...createForm })
    ElMessage.success('批次已建立，请加入本批检查记录')
    createVisible.value = false
    detailId.value = batch.id
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '创建失败')
  } finally {
    submitting.value = false
  }
}

function openDetail(batch: SurveyBatch): void {
  detailId.value = batch.id
}

function openAttach(batch: SurveyBatch): void {
  attachTargetId.value = batch.id
  attachSelected.value = []
  attachVisible.value = true
}

async function handleAttach(): Promise<void> {
  if (attachTargetId.value === null) return
  if (attachSelected.value.length === 0) {
    ElMessage.warning('请先勾选未交回的检查记录')
    return
  }
  await batchStore.addSurveys(attachTargetId.value, attachSelected.value)
  ElMessage.success(`已加入 ${attachSelected.value.length} 条检查记录`)
  attachVisible.value = false
}

async function handleDetach(batch: SurveyBatch, survey: Survey): Promise<void> {
  await batchStore.removeSurvey(batch.id, survey.id)
  ElMessage.success('已从批次摘除，记录回到未交回')
}

async function handleSubmit(batch: SurveyBatch): Promise<void> {
  try {
    await batchStore.submit(batch.id)
    ElMessage.success('已交回保护科核对，批次明细已锁定')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '交回失败')
  }
}

function openReturn(batch: SurveyBatch): void {
  returnTargetId.value = batch.id
  returnReason.value = batch.returnReason
  returnVisible.value = true
}

async function handleReturn(): Promise<void> {
  if (returnTargetId.value === null) return
  try {
    await batchStore.sendBack(returnTargetId.value, returnReason.value)
    ElMessage.success('已整批退回，保护科台账未改动')
    returnVisible.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '退回失败')
  }
}

async function handleReconcile(batch: SurveyBatch): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `对账将按古树现档保护级别与保护科周期标准，以批次内最新检查日期重算覆盖到的加固件；原待检计划作废并重新排队。巡检带回的旧级别不参与计算。`,
      '确认对账？',
      { type: 'warning', confirmButtonText: '确认对账', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  try {
    const result = await batchStore.reconcile(batch.id)
    ElMessage.success(
      `对账完成：覆盖 ${result.trees} 株、${result.supports} 件加固件，重排后 ${result.plans} 件在待检队列`,
    )
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '对账失败')
  }
}

async function handleDelete(batch: SurveyBatch): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认删除批次「${batch.name}」？明细检查记录会回到未交回。`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  await batchStore.deleteBatch(batch.id)
  if (detailId.value === batch.id) detailId.value = null
  ElMessage.success('批次已删除')
}

/** 该批次某树：巡检带回级别 vs 现档级别（不同则以现档为准并标红） */
function levelPair(batch: SurveyBatch, treeId: string): { snapshot: string; current: string; changed: boolean } {
  const snapshotValue = batch.levelSnapshot[treeId]
  const snapshot = snapshotValue === undefined ? '—' : snapshotValue
  const current = treeStore.trees.find((tree) => tree.id === treeId)?.protectLevel ?? '已删除'
  return { snapshot, current, changed: snapshotValue !== undefined && snapshotValue !== current }
}

/** 模板用：当前抽屉批次内某条检查记录的级别对照（currentBatch 为 null 时给空值） */
function pairOfSurvey(survey: Survey): { snapshot: string; current: string; changed: boolean } {
  if (currentBatch.value === null) return { snapshot: '—', current: '—', changed: false }
  return levelPair(currentBatch.value, survey.treeId)
}

/** 批次覆盖的加固件数（对账影响范围预览） */
function coveredSupportCount(batch: SurveyBatch): number {
  const treeIds = new Set(currentTreeIds(batch))
  return treeStore.supports.filter((support) => treeIds.has(support.treeId)).length
}

function currentTreeIds(batch: SurveyBatch): string[] {
  return Array.from(new Set(batchStore.surveysOfBatch(batch.id).map((survey) => survey.treeId)))
}

function riskText(survey: Survey): string {
  if (survey.leanDeg > LEAN_DANGER_DEG) return `倾斜超限 ${survey.leanDeg}°`
  if (survey.hollowCount >= 3) return `空洞高风险 ${survey.hollowCount} 处`
  return ''
}
</script>

<template>
  <div>
    <div class="stat-row">
      <StatBadge label="批次总数" :value="treeStore.batches.length" suffix="个" tone="primary" icon="Files" />
      <StatBadge label="草稿" :value="statusCount['草稿']" suffix="个" tone="info" icon="EditPen" />
      <StatBadge label="已交回" :value="statusCount['已交回']" suffix="个" tone="warning" icon="Promotion" />
      <StatBadge label="已退回" :value="statusCount['已退回']" suffix="个" tone="danger" icon="RefreshLeft" />
      <StatBadge label="已对账" :value="statusCount['已对账']" suffix="个" tone="success" icon="CircleCheck" />
      <StatBadge label="未交回记录" :value="batchStore.unassignedSurveys.length" suffix="条" tone="default" icon="Document" size="small" />
    </div>

    <el-alert
      :type="roleStore.isPatrol() ? 'info' : 'success'"
      show-icon
      :closable="false"
      class="mb-14"
      :title="
        roleStore.isPatrol()
          ? '巡检班：在此编组树体检查批次并交回；上门才发现的倾斜超限 / 空洞高风险只记入检查记录，加固件周期照旧排。'
          : '保护科：核对交回批次，有一条不对即整批退回（台账不动）；交齐无误后对账，按现档级别重算加固件并重排待检清单。'
      "
    />

    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">树体检查批次交回与对账</span>
          <el-button v-if="roleStore.isPatrol()" type="primary" @click="openCreate">
            <el-icon><Plus /></el-icon>
            <span>新建批次</span>
          </el-button>
        </div>
      </template>

      <div class="filter-row">
        <el-radio-group v-model="statusFilter" size="small">
          <el-radio-button label="all">全部</el-radio-button>
          <el-radio-button v-for="status in BATCH_STATUS_OPTIONS" :key="status" :label="status">
            {{ status }}
          </el-radio-button>
        </el-radio-group>
        <el-input v-model="keyword" placeholder="搜索批次名称" clearable size="small" style="width: 240px" />
      </div>

      <EmptyPanel
        v-if="filteredBatches.length === 0"
        title="当前筛选下没有批次"
        :description="roleStore.isPatrol() ? '巡检班可新建批次，把上门检查记录编组后交回保护科。' : '等待巡检班交回检查批次。'"
        :action-text="roleStore.isPatrol() ? '新建批次' : ''"
        @action="openCreate"
      />

      <el-table v-else :data="filteredBatches" row-key="id" stripe>
        <el-table-column label="批次名称 / 上门日期" min-width="240">
          <template #default="{ row }">
            <div class="cell-stack">
              <el-link type="primary" @click="openDetail(row)">{{ row.name }}</el-link>
              <span class="cell-sub">上门 {{ row.visitDate }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag :type="statusTagType(row.status)" effect="dark" size="small">{{ row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="交回进度" width="120">
          <template #default="{ row }">
            <span :class="{ 'cell-warn': row.surveyIds.length !== row.plannedCount }">
              {{ row.surveyIds.length }} / {{ row.plannedCount }} 株
            </span>
          </template>
        </el-table-column>
        <el-table-column label="覆盖加固件" width="110" align="right">
          <template #default="{ row }">{{ coveredSupportCount(row) }} 件</template>
        </el-table-column>
        <el-table-column label="退回原因 / 备注" min-width="220">
          <template #default="{ row }">
            <span v-if="row.returnReason" class="cell-warn">{{ row.returnReason }}</span>
            <span v-else-if="row.status === '已对账'" class="cell-sub">已对账 {{ row.reconciledAt.slice(0, 10) }}</span>
            <span v-else class="cell-sub">—</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="300" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="openDetail(row)">明细</el-button>
            <template v-if="roleStore.isPatrol()">
              <el-button
                v-if="row.status === '草稿' || row.status === '已退回'"
                link
                type="primary"
                size="small"
                @click="openAttach(row)"
              >
                加入记录
              </el-button>
              <el-button
                v-if="row.status === '草稿' || row.status === '已退回'"
                link
                type="success"
                size="small"
                @click="handleSubmit(row)"
              >
                交回
              </el-button>
              <el-button link type="danger" size="small" @click="handleDelete(row)">删除</el-button>
            </template>
            <template v-else>
              <el-button
                v-if="row.status === '已交回'"
                link
                type="danger"
                size="small"
                @click="openReturn(row)"
              >
                整批退回
              </el-button>
              <el-button
                v-if="row.status === '已交回'"
                link
                type="success"
                size="small"
                @click="handleReconcile(row)"
              >
                对账
              </el-button>
            </template>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 明细抽屉 -->
    <el-drawer
      :model-value="currentBatch !== null"
      :size="640"
      :with-header="false"
      :destroy-on-close="false"
      @close="detailId = null"
    >
      <template #default="{ close }">
        <div v-if="currentBatch" class="detail">
          <div class="detail-head">
            <div>
              <h2 class="detail-title">{{ currentBatch.name }}</h2>
              <p class="cell-sub">
                上门 {{ currentBatch.visitDate }} · 计划 {{ currentBatch.plannedCount }} 株 ·
                已交 {{ currentBatch.surveyIds.length }} 条
              </p>
            </div>
            <div>
              <el-tag :type="statusTagType(currentBatch.status)" effect="dark">{{ currentBatch.status }}</el-tag>
              <el-button link @click="close()">关闭</el-button>
            </div>
          </div>

          <el-alert
            v-if="currentBatch.status === '已退回'"
            type="error"
            show-icon
            :closable="false"
            class="mb-14"
            :title="`整批退回原因：${currentBatch.returnReason || '（未填写）'}`"
            description="保护科台账未做任何改动；请巡检班修正后重新交回。"
          />
          <el-alert
            v-if="currentBatch.status === '已对账'"
            type="success"
            show-icon
            :closable="false"
            class="mb-14"
            :title="`已于 ${currentBatch.reconciledAt.slice(0, 10)} 对账完成，明细记录已锁定`"
          />

          <el-table :data="currentSurveys" row-key="id" size="small" stripe class="mb-14">
            <el-table-column label="古树 / 检查日期" min-width="170">
              <template #default="{ row }">
                <div class="cell-stack">
                  <span>{{ treeLabel[row.treeId] ?? '（古树已删除）' }}</span>
                  <span class="cell-sub">{{ row.date }}</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="级别对照" width="150">
              <template #default="{ row }">
                <div class="cell-stack">
                  <el-tag size="small" type="info" effect="plain">带回 {{ pairOfSurvey(row).snapshot }}</el-tag>
                  <el-tag size="small" :type="pairOfSurvey(row).changed ? 'danger' : 'success'" effect="dark">
                    现档 {{ pairOfSurvey(row).current }}
                  </el-tag>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="现场发现" min-width="150">
              <template #default="{ row }">
                <el-tag v-if="riskText(row)" size="small" type="danger" effect="dark">{{ riskText(row) }}</el-tag>
                <span v-else class="cell-sub">倾斜 {{ row.leanDeg }}° / 空洞 {{ row.hollowCount }} 处</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="90">
              <template #default="{ row }">
                <el-button
                  v-if="roleStore.isPatrol() && (currentBatch.status === '草稿' || currentBatch.status === '已退回')"
                  link
                  type="warning"
                  size="small"
                  @click="handleDetach(currentBatch, row)"
                >
                  摘除
                </el-button>
                <span v-else-if="currentBatch.status === '已交回' || currentBatch.status === '已对账'" class="cell-sub">已锁定</span>
              </template>
            </el-table-column>
          </el-table>

          <el-alert
            v-if="currentSurveys.some((survey) => pairOfSurvey(survey).changed)"
            type="warning"
            show-icon
            :closable="false"
            class="mb-14"
            title="存在保护级别不一致：对账一律以古树现档级别为准，巡检带回的旧级别不参与周期重算。"
          />

          <div class="detail-actions">
            <template v-if="roleStore.isPatrol()">
              <el-button
                v-if="currentBatch.status === '草稿' || currentBatch.status === '已退回'"
                type="primary"
                @click="openAttach(currentBatch)"
              >
                加入检查记录
              </el-button>
              <el-button
                type="success"
                :disabled="currentBatch.surveyIds.length !== currentBatch.plannedCount"
                @click="handleSubmit(currentBatch)"
              >
                {{ currentBatch.surveyIds.length === currentBatch.plannedCount ? '交回保护科' : `交齐 ${currentBatch.plannedCount} 株后可交回` }}
              </el-button>
            </template>
            <template v-else>
              <el-button v-if="currentBatch.status === '已交回'" type="danger" @click="openReturn(currentBatch)">
                有一条不对 · 整批退回
              </el-button>
              <el-button
                v-if="currentBatch.status === '已交回'"
                type="success"
                :disabled="currentBatch.surveyIds.length !== currentBatch.plannedCount"
                @click="handleReconcile(currentBatch)"
              >
                核对无误 · 对账
              </el-button>
            </template>
          </div>
        </div>
      </template>
    </el-drawer>

    <!-- 新建批次 -->
    <el-dialog v-model="createVisible" title="新建巡检批次" width="520px">
      <el-form ref="formRef" :model="createForm" :rules="createRules" label-width="120px">
        <el-form-item label="批次名称" prop="name">
          <el-input v-model="createForm.name" placeholder="如：2026 年四季度国子监片区巡检" />
        </el-form-item>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="上门日期" prop="visitDate">
              <el-date-picker v-model="createForm.visitDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="计划株数" prop="plannedCount">
              <el-input-number v-model="createForm.plannedCount" :min="1" :max="999" :step="1" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="handleCreate">建立批次</el-button>
      </template>
    </el-dialog>

    <!-- 加入未交回记录 -->
    <el-dialog v-model="attachVisible" title="加入未交回检查记录" width="720px">
      <el-alert
        type="info"
        show-icon
        :closable="false"
        class="mb-14"
        title="仅列出尚未交回（未编入已交回 / 已对账批次）的检查记录；加入后随批次一起交回。"
      />
      <el-table
        :data="batchStore.unassignedSurveys"
        row-key="id"
        size="small"
        max-height="360"
        @selection-change="(rows: Survey[]) => (attachSelected = rows.map((row) => row.id))"
      >
        <el-table-column type="selection" width="46" />
        <el-table-column label="古树" min-width="160">
          <template #default="{ row }">{{ treeLabel[row.treeId] ?? '（古树已删除）' }}</template>
        </el-table-column>
        <el-table-column prop="date" label="检查日期" width="120" />
        <el-table-column label="现场" min-width="140">
          <template #default="{ row }">{{ riskText(row) || `倾斜 ${row.leanDeg}° / 空洞 ${row.hollowCount} 处` }}</template>
        </el-table-column>
      </el-table>
      <template #footer>
        <el-button @click="attachVisible = false">取消</el-button>
        <el-button type="primary" @click="handleAttach">加入选中（{{ attachSelected.length }}）</el-button>
      </template>
    </el-dialog>

    <!-- 整批退回 -->
    <el-dialog v-model="returnVisible" title="整批退回（保护科台账不动）" width="520px">
      <el-alert
        type="warning"
        show-icon
        :closable="false"
        class="mb-14"
        title="批次中有任意一条检查记录不对，即整批退回巡检班重报；加固件台账、周期与待检清单均不改动。"
      />
      <el-input v-model="returnReason" type="textarea" :rows="4" placeholder="请填写退回原因，如：某株胸径与现场复核不符。" />
      <template #footer>
        <el-button @click="returnVisible = false">取消</el-button>
        <el-button type="danger" @click="handleReturn">确认整批退回</el-button>
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

.filter-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
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

.cell-stack {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.cell-sub {
  font-size: 12px;
  color: #8c8479;
}

.cell-warn {
  color: #c0392b;
  font-weight: 600;
}

.mb-14 {
  margin-bottom: 14px;
}

.detail {
  padding: 20px;
}

.detail-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
}

.detail-title {
  margin: 0 0 4px;
  font-size: 17px;
  color: #2f2a24;
}

.detail-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
</style>
