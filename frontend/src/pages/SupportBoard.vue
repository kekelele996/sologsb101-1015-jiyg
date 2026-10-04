<script setup lang="ts">
/**
 * /supports 加固件台账、周期标准与季度排期（保护科侧）
 * - 巡检班只在「检查批次」里上报，本页不提供逐件登记检查；
 * - 周期由保护科按古树现档保护级别统一定档，现场发现倾斜超限 / 空洞高风险不改周期；
 * - 每季度检查容量有限，排不完的加固件排队等下一批；
 *   对账通过的件按最新检查日期重算、原排期作废重新进待检清单。
 * 消费模型：Support、Tree、CycleStandard、AppSetting；复用组件：<StatBadge>、<EmptyPanel>、<FilterBar>、<VigorTag>
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import VigorTag from '@/components/common/VigorTag.vue'
import { useTreeStore } from '@/stores/treeStore'
import { useSupportStore } from '@/stores/supportStore'
import { SUPPORT_TYPE_OPTIONS, type Support, type SupportDraft, type SupportType } from '@/types/support'
import type { ScheduleEntry } from '@/utils/scheduling'
import { quarterLabel } from '@/utils/quarter'
import { overdueDays } from '@/utils/dimension'
import { today } from '@/utils/id'

const treeStore = useTreeStore()
const supportStore = useSupportStore()

const keyword = ref('')
const treeFilter = ref('all')
const typeFilter = ref<SupportType | 'all'>('all')
const overdueOnly = ref(false)

const dialogVisible = ref(false)
const submitting = ref(false)
const editingId = ref<string | null>(null)
const formRef = ref<FormInstance>()

const form = reactive<SupportDraft>({
  treeId: '',
  type: '支撑杆',
  installDate: '',
  checkCycleMon: 12,
  lastCheckDate: '',
})

const rules: FormRules<SupportDraft> = {
  treeId: [{ required: true, message: '请选择古树', trigger: 'change' }],
  type: [{ required: true, message: '请选择加固件类型', trigger: 'change' }],
  installDate: [{ required: true, message: '请选择安装日期', trigger: 'change' }],
}

const treeLabel = computed<Record<string, string>>(() =>
  Object.fromEntries(treeStore.trees.map((tree) => [tree.id, `${tree.code} ${tree.species}`]))
)

function levelOf(support: Support): string {
  return treeStore.trees.find((tree) => tree.id === support.treeId)?.protectLevel ?? '—'
}

const filteredEntries = computed<ScheduleEntry[]>(() => {
  const key = keyword.value.trim().toLowerCase()
  return supportStore.schedule.entries
    .filter((entry) => {
      const row = entry.support
      if (treeFilter.value !== 'all' && row.treeId !== treeFilter.value) return false
      if (typeFilter.value !== 'all' && row.type !== typeFilter.value) return false
      if (overdueOnly.value && !supportStore.isOverdue(row)) return false
      if (key === '') return true
      return (
        (treeLabel.value[row.treeId] ?? '').toLowerCase().includes(key) ||
        row.type.toLowerCase().includes(key) ||
        row.lastCheckDate.includes(key)
      )
    })
    .sort((a, b) => a.due.localeCompare(b.due) || a.support.installDate.localeCompare(b.support.installDate))
})

const plannedEntries = computed(() => supportStore.schedule.entries.filter((entry) => entry.bucket === 'planned'))
const queuedEntries = computed(() => supportStore.schedule.entries.filter((entry) => entry.bucket === 'queued'))

/** 容量设置的行内草稿 */
const cycleDrafts = reactive<Record<string, number>>({})
const capacityDraft = ref(0)

onMounted(() => {
  void treeStore.loadAll()
  void supportStore.loadAll().then(() => {
    supportStore.standards.forEach((row) => {
      cycleDrafts[row.id] = row.checkCycleMon
    })
    capacityDraft.value = supportStore.quarterCapacity
  })
})

function rowClassName({ row }: { row: ScheduleEntry }): string {
  return supportStore.isOverdue(row.support) ? 'row-overdue' : ''
}

function statusTag(entry: ScheduleEntry): { type: 'info' | 'warning' | 'success' | 'primary'; text: string } {
  switch (entry.bucket) {
    case 'planned':
      return { type: 'success', text: `已排入 ${entry.assignedQuarter}` }
    case 'queued':
      return { type: 'warning', text: '待检排队' }
    case 'future':
      return { type: 'info', text: `已排入 ${entry.assignedQuarter}` }
    default:
      return { type: 'info', text: '未到期' }
  }
}

function openCreate(): void {
  const treeId =
    treeFilter.value !== 'all' ? treeFilter.value : (treeStore.currentTreeId ?? treeStore.trees[0]?.id ?? '')
  editingId.value = null
  Object.assign(form, {
    treeId,
    type: '支撑杆' as SupportType,
    installDate: today(),
    checkCycleMon: 12,
    lastCheckDate: '',
  })
  dialogVisible.value = true
}

function openEdit(entry: ScheduleEntry): void {
  const row = entry.support
  editingId.value = row.id
  Object.assign(form, {
    treeId: row.treeId,
    type: row.type,
    installDate: row.installDate,
    checkCycleMon: row.checkCycleMon,
    lastCheckDate: row.lastCheckDate,
  })
  dialogVisible.value = true
}

/** 表单所选古树对应的现档级别与周期（只读预览） */
const formLevel = computed(() => {
  const tree = treeStore.trees.find((item) => item.id === form.treeId) ?? null
  if (!tree) return { level: '', cycle: 0 }
  const standard = supportStore.standards.find((row) => row.id === tree.protectLevel)
  return { level: tree.protectLevel, cycle: standard?.checkCycleMon ?? form.checkCycleMon }
})

async function handleSubmit(): Promise<void> {
  if (formRef.value === undefined) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  submitting.value = true
  try {
    if (editingId.value === null) {
      await supportStore.createSupport({ ...form, checkCycleMon: formLevel.value.cycle || 12 })
      ElMessage.success('加固件已登记，周期按古树现档级别自动定档')
    } else {
      await supportStore.updateSupport(editingId.value, { ...form, checkCycleMon: formLevel.value.cycle || 12 })
      ElMessage.success('加固件已更新')
    }
    dialogVisible.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败')
  } finally {
    submitting.value = false
  }
}

async function handleDelete(entry: ScheduleEntry): Promise<void> {
  const row = entry.support
  try {
    await ElMessageBox.confirm(`确认删除「${row.type}」加固件记录？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  await supportStore.deleteSupport(row.id)
  ElMessage.success('加固件记录已删除')
}

async function handleSchedule(): Promise<void> {
  const count = await supportStore.runScheduling()
  if (count > 0) ElMessage.success(supportStore.lastMessage)
  else ElMessage.info(supportStore.lastMessage)
}

async function handleSaveCycle(tier: string): Promise<void> {
  const value = cycleDrafts[tier]
  if (!Number.isFinite(value) || value <= 0) {
    ElMessage.error('检查周期须为大于 0 的月数')
    return
  }
  await supportStore.saveCycle(tier as never, value)
  ElMessage.success(supportStore.lastMessage)
}

async function handleSaveCapacity(): Promise<void> {
  if (!Number.isFinite(capacityDraft.value) || capacityDraft.value < 0) {
    ElMessage.error('每季度容量须为不小于 0 的整数')
    return
  }
  await supportStore.saveCapacity(capacityDraft.value)
  ElMessage.success(supportStore.lastMessage)
}

function handleRollQuarter(): void {
  supportStore.rollToNextQuarter()
  ElMessage.info(`已切换查看 ${quarterLabel(supportStore.currentQuarter)} 的排期`)
}

function handleFilterChange(key: string, value: string): void {
  if (key === 'treeId') treeFilter.value = value
  if (key === 'type') typeFilter.value = value as SupportType | 'all'
}
</script>

<template>
  <div>
    <div class="stat-row">
      <StatBadge label="加固件总数" :value="supportStore.supports.length" suffix="件" tone="primary" icon="Histogram" />
      <StatBadge
        label="超期未检查"
        :value="supportStore.overdueSupports.length"
        suffix="件"
        :tone="supportStore.overdueSupports.length > 0 ? 'danger' : 'success'"
        icon="Warning"
        hint="按保护科周期（古树现档级别定档）计算"
      />
      <StatBadge
        :label="`${supportStore.currentQuarter} 已排入`"
        :value="plannedEntries.length"
        suffix="件"
        tone="success"
        icon="DataLine"
        :hint="`本季度容量 ${supportStore.quarterCapacity} 件`"
      />
      <StatBadge
        label="待检排队"
        :value="queuedEntries.length"
        suffix="件"
        :tone="queuedEntries.length > 0 ? 'warning' : 'success'"
        icon="PieChart"
        hint="到期但本季容量不足，顺延下一批"
      />
    </div>

    <!-- 保护科：周期标准与每季度检查容量 -->
    <el-card shadow="never" class="mb-14">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">周期标准与季度容量（保护科）</span>
          <el-tag type="info" effect="plain">巡检侧只读，以古树现档保护级别为准</el-tag>
        </div>
      </template>
      <el-alert
        type="info"
        show-icon
        :closable="false"
        class="mb-14"
        title="加固件检查周期由保护科按保护级别统一定档；巡检班上门发现倾斜超限或空洞高风险，只记入树体检查记录，不改变加固件周期。保护级别被保护科调整后，对账 / 排期一律以现档为准，巡检带回的旧级别不采信。"
      />
      <el-row :gutter="20">
        <el-col :xs="24" :md="14">
          <el-table :data="supportStore.standards" size="small" border>
            <el-table-column prop="id" label="保护级别档位" width="130" />
            <el-table-column label="检查周期（月）" width="180">
              <template #default="{ row }">
                <el-input-number v-model="cycleDrafts[row.id]" :min="1" :max="120" :step="1" size="small" />
              </template>
            </el-table-column>
            <el-table-column label="操作">
              <template #default="{ row }">
                <el-button size="small" type="primary" @click="handleSaveCycle(row.id)">保存档位</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-col>
        <el-col :xs="24" :md="10">
          <div class="capacity-box">
            <span class="capacity-label">每季度检查容量（件 / 季）</span>
            <el-input-number v-model="capacityDraft" :min="0" :max="999" :step="1" />
            <el-button type="primary" @click="handleSaveCapacity">保存容量</el-button>
            <span class="capacity-hint">容量有限：当季排不完的排队等下一批，查完（对账通过）的不再改。</span>
          </div>
        </el-col>
      </el-row>
    </el-card>

    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">加固件台账与待检清单</span>
          <el-space wrap>
            <el-tag type="info" effect="plain">当前排期季度：{{ quarterLabel(supportStore.currentQuarter) }}</el-tag>
            <el-button @click="handleRollQuarter">切到下一季度</el-button>
            <el-button type="primary" plain @click="handleSchedule">
              生成 / 刷新{{ supportStore.currentQuarter }}排期
            </el-button>
            <el-button type="primary" @click="openCreate" :disabled="treeStore.trees.length === 0">
              <el-icon><Plus /></el-icon>
              <span>登记加固件</span>
            </el-button>
          </el-space>
        </div>
      </template>

      <FilterBar
        :keyword="keyword"
        :fields="[
          {
            key: 'treeId',
            label: '古树',
            options: treeStore.trees.map((tree) => tree.id),
            optionLabels: treeLabel,
          },
          { key: 'type', label: '类型', options: SUPPORT_TYPE_OPTIONS as unknown as string[] },
        ]"
        :values="{ treeId: treeFilter, type: typeFilter }"
        :result-text="`命中 ${filteredEntries.length} / ${supportStore.supports.length} 件`"
        @update:keyword="(value: string) => (keyword = value)"
        @change="handleFilterChange"
        @reset="
          () => {
            keyword = ''
            treeFilter = 'all'
            typeFilter = 'all'
            overdueOnly = false
          }
        "
      >
        <template #extra>
          <el-checkbox v-model="overdueOnly" border size="small">只看超期未检查</el-checkbox>
        </template>
      </FilterBar>

      <EmptyPanel
        v-if="supportStore.supports.length === 0 && supportStore.ready"
        title="还没有加固件记录"
        description="由保护科登记支撑杆、拉纤与避雷件；检查周期按古树保护级别自动定档，巡检结果在「检查批次」里上报并对账。"
        action-text="登记第一件加固件"
        @action="openCreate"
      />

      <el-table
        v-else
        v-loading="!supportStore.ready || !treeStore.ready"
        :data="filteredEntries"
        row-key="support.id"
        stripe
        :row-class-name="rowClassName"
      >
        <el-table-column label="古树" min-width="180">
          <template #default="{ row }">
            <div class="cell-stack">
              <span>{{ treeLabel[row.support.treeId] ?? '（古树已删除）' }}</span>
              <VigorTag
                :vigor="treeStore.statOf(row.support.treeId).latestVigor"
                :trend="treeStore.statOf(row.support.treeId).latestTrend"
                size="small"
              />
            </div>
          </template>
        </el-table-column>
        <el-table-column label="类型" width="100">
          <template #default="{ row }">
            <el-tag :type="row.support.type === '避雷' ? 'warning' : row.support.type === '拉纤' ? 'info' : 'success'">
              {{ row.support.type }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="现档级别" width="100">
          <template #default="{ row }">
            <el-tag :type="levelOf(row.support) === '一级' ? 'danger' : levelOf(row.support) === '二级' ? 'warning' : 'info'" size="small">
              {{ levelOf(row.support) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="保护科周期" width="110" align="right">
          <template #default="{ row }">{{ row.cycleMon }} 个月</template>
        </el-table-column>
        <el-table-column label="安装日期" width="110">
          <template #default="{ row }">{{ row.support.installDate }}</template>
        </el-table-column>
        <el-table-column label="最近检查" width="120">
          <template #default="{ row }">
            <span v-if="row.support.lastCheckDate === ''" class="cell-warn">未记录</span>
            <span v-else>{{ row.support.lastCheckDate }}</span>
          </template>
        </el-table-column>
        <el-table-column label="下次应检查" width="120">
          <template #default="{ row }">{{ row.due || '—' }}</template>
        </el-table-column>
        <el-table-column label="检查状态" width="170">
          <template #default="{ row }">
            <el-tag v-if="supportStore.isOverdue(row.support)" type="danger" effect="dark">
              超期 {{ overdueDays(row.support.lastCheckDate === '' ? row.support.installDate : row.support.lastCheckDate, row.cycleMon) }} 天
            </el-tag>
            <el-tag v-else type="success" effect="light">周期内</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="排期状态" width="150">
          <template #default="{ row }">
            <el-tag :type="statusTag(row).type" size="small" effect="plain">{{ statusTag(row).text }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="160" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" size="small" @click="handleDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="editingId === null ? '登记加固件（保护科）' : '编辑加固件（保护科）'" width="600px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="120px">
        <el-form-item label="古树" prop="treeId">
          <el-select v-model="form.treeId" filterable style="width: 100%">
            <el-option
              v-for="tree in treeStore.trees"
              :key="tree.id"
              :value="tree.id"
              :label="`${tree.code} · ${tree.species} · ${tree.location}`"
            />
          </el-select>
        </el-form-item>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="类型" prop="type">
              <el-select v-model="form.type" style="width: 100%">
                <el-option v-for="item in SUPPORT_TYPE_OPTIONS" :key="item" :value="item" :label="item" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="安装日期" prop="installDate">
              <el-date-picker v-model="form.installDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="最近检查日期">
          <el-date-picker v-model="form.lastCheckDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
        </el-form-item>
        <el-alert
          type="success"
          show-icon
          :closable="false"
          :title="formLevel.level === '' ? '保存后按所选古树的现档保护级别自动定检查周期' : `现档「${formLevel.level}」→ 检查周期 ${formLevel.cycle} 个月`"
          description="周期不由巡检按次修改；巡检结果在「检查批次」上报、保护科对账通过后，才会回写最近检查日期并重算排期。"
        />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="handleSubmit">保存</el-button>
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

.capacity-box {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
}

.capacity-label {
  font-size: 13px;
  color: #4a4338;
  font-weight: 600;
}

.capacity-hint {
  font-size: 12px;
  color: #8c8479;
  line-height: 1.6;
}

.cell-stack {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.cell-warn {
  color: #c0392b;
  font-weight: 600;
}

.mb-14 {
  margin-bottom: 14px;
}

:deep(.row-overdue) {
  --el-table-tr-bg-color: #fdf3f2;
}
</style>
