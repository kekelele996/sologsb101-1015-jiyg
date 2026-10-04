<script setup lang="ts">
/**
 * /supports 加固件台账与待检清单（保护科职责）
 * - 台账：支撑杆 / 拉纤 / 避雷登记，周期不在本件填写，按古树现档保护级别查周期标准派生；
 * - 待检清单：按季度容量排队，排不完的顺延下一季度，登记检查后原计划冻结、新计划重排；
 * - 周期标准：保护科按保护级别制定（一级 / 二级 / 三级 → 月数）与每季度检查容量。
 * 巡检班角色仅可查看，不能登记 / 删除 / 改周期 / 改容量。
 * 消费模型：Support、Tree、CycleStandard、SupportCheckPlan；复用组件：<StatBadge>、<EmptyPanel>、<FilterBar>
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import VigorTag from '@/components/common/VigorTag.vue'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useTreeStore } from '@/stores/treeStore'
import { useCycleStore } from '@/stores/cycleStore'
import { useRoleStore } from '@/stores/roleStore'
import { db, removeSupport, resolveSupportCycleLevel } from '@/utils/db'
import { SUPPORT_TYPE_OPTIONS, type Support, type SupportDraft, type SupportType } from '@/types/support'
import { PROTECT_LEVEL_OPTIONS, type ProtectLevel } from '@/types/tree'
import { isSupportOverdue, nextCheckDate, overdueDays } from '@/utils/dimension'
import { quarterOf } from '@/utils/cycle'
import { today } from '@/utils/id'

const treeStore = useTreeStore()
const cycleStore = useCycleStore()
const roleStore = useRoleStore()

const { rows, loading, create } = useIdbTable<Support>(db.supports, { sortByUpdatedAt: false })

/** 当前季度，用于徽标与高亮 */
const quarterNow = quarterOf(today())

const keyword = ref('')
const treeFilter = ref('all')
const typeFilter = ref<SupportType | 'all'>('all')
const overdueOnly = ref(false)
const activeTab = ref<'ledger' | 'queue' | 'standard'>('ledger')

const dialogVisible = ref(false)
const submitting = ref(false)
const formRef = ref<FormInstance>()

const form = reactive<SupportDraft>({
  treeId: '',
  type: '支撑杆',
  installDate: '',
  lastCheckDate: '',
})

const rules: FormRules<SupportDraft> = {
  treeId: [{ required: true, message: '请选择古树', trigger: 'change' }],
  type: [{ required: true, message: '请选择加固件类型', trigger: 'change' }],
  installDate: [{ required: true, message: '请选择安装日期', trigger: 'change' }],
}

/** 周期标准编辑草稿（级别 → 月数） */
const standardDraft = reactive<Record<ProtectLevel, number>>({ 一级: 6, 二级: 12, 三级: 24 })
const capacityDraft = ref(cycleStore.capacity)

const treeLabel = computed<Record<string, string>>(() =>
  Object.fromEntries(treeStore.trees.map((tree) => [tree.id, `${tree.code} ${tree.species}`]))
)

function cycleMon(row: Support): number {
  return treeStore.effectiveCycleMon(row)
}

function levelOf(row: Support): ProtectLevel {
  return treeStore.levelOfTree(row.treeId) ?? row.cycleLevel
}

const filtered = computed<Support[]>(() => {
  const key = keyword.value.trim().toLowerCase()
  return rows.value
    .filter((row) => {
      if (treeFilter.value !== 'all' && row.treeId !== treeFilter.value) return false
      if (typeFilter.value !== 'all' && row.type !== typeFilter.value) return false
      if (overdueOnly.value && !isSupportOverdue(row.lastCheckDate, cycleMon(row))) return false
      if (key === '') return true
      return (
        (treeLabel.value[row.treeId] ?? '').toLowerCase().includes(key) ||
        row.type.toLowerCase().includes(key) ||
        row.lastCheckDate.includes(key)
      )
    })
    .sort((a, b) => a.installDate.localeCompare(b.installDate))
})

const overdueRows = computed<Support[]>(() =>
  rows.value.filter((row) => isSupportOverdue(row.lastCheckDate, cycleMon(row)))
)

const coveredTrees = computed<number>(() => new Set(rows.value.map((row) => row.treeId)).size)
const staleRows = computed<Support[]>(() => rows.value.filter((row) => treeStore.supportLevelStale(row)))

const planSupport = computed<Record<string, Support>>(() =>
  Object.fromEntries(rows.value.map((row) => [row.id, row]))
)

const standardRows = computed<{ level: ProtectLevel }[]>(() => PROTECT_LEVEL_OPTIONS.map((level) => ({ level })))

/** el-table 插槽 row 为隐式 any，用带类型的读写辅助避免索引报错 */
function standardMonthsOf(row: { level: ProtectLevel }): number {
  return standardDraft[row.level]
}
function setStandardMonths(row: { level: ProtectLevel }, value: number | undefined): void {
  if (value === undefined) return
  standardDraft[row.level] = value
}

onMounted(() => {
  void treeStore.loadAll().then(syncStandardDraft)
  void cycleStore.loadSettings().then(() => {
    capacityDraft.value = cycleStore.capacity
  })
})

function rowClassName({ row }: { row: Support }): string {
  return isSupportOverdue(row.lastCheckDate, cycleMon(row)) ? 'row-overdue' : ''
}

function syncStandardDraft(): void {
  PROTECT_LEVEL_OPTIONS.forEach((level) => {
    standardDraft[level] = cycleStore.standardRow(level)?.checkCycleMon ?? standardDraft[level]
  })
}

async function openCreate(): Promise<void> {
  const treeId =
    treeFilter.value !== 'all' ? treeFilter.value : (treeStore.currentTreeId ?? treeStore.trees[0]?.id ?? '')
  Object.assign(form, {
    treeId,
    type: '支撑杆' as SupportType,
    installDate: today(),
    lastCheckDate: '',
  })
  dialogVisible.value = true
}

async function handleSubmit(): Promise<void> {
  if (formRef.value === undefined) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  submitting.value = true
  try {
    const cycleLevel = await resolveSupportCycleLevel(form.treeId)
    await create(
      {
        treeId: form.treeId,
        type: form.type,
        installDate: form.installDate,
        cycleLevel,
        lastCheckDate: form.lastCheckDate,
      },
      'support',
    )
    const months = cycleMon({ cycleLevel, treeId: form.treeId } as Support)
    ElMessage.success(`加固件已登记，按古树现档「${cycleLevel}」保护执行 ${months} 个月周期`)
    dialogVisible.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败')
  } finally {
    submitting.value = false
  }
}

async function handleDelete(row: Support): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确认删除「${treeLabel.value[row.treeId] ?? ''} ${row.type}」加固件及其待检计划？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  await removeSupport(row.id)
  ElMessage.success('加固件与待检计划已删除')
}

async function handleCheckPlan(planId: string): Promise<void> {
  try {
    await ElMessageBox.confirm('确认本季度已完成该加固件检查？查完的计划将冻结，新周期计划重新排队。', '登记检查', {
      type: 'info',
      confirmButtonText: '确认已查',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  await cycleStore.checkPlan(planId, today())
  ElMessage.success('已登记检查，待检队列已重排')
}

async function handleSaveStandard(level: ProtectLevel): Promise<void> {
  const months = standardDraft[level]
  if (!Number.isFinite(months) || months < 1) {
    ElMessage.error('周期必须为不小于 1 的整数月')
    return
  }
  await cycleStore.saveStandard(level, Math.floor(months))
  ElMessage.success(`「${level}」保护周期标准已更新，待检队列已按新标准重排`)
}

async function handleSaveCapacity(): Promise<void> {
  if (!Number.isFinite(capacityDraft.value) || capacityDraft.value < 1) {
    ElMessage.error('每季度容量必须为不小于 1 的整数')
    return
  }
  await cycleStore.saveCapacity(Math.floor(capacityDraft.value))
  ElMessage.success('季度检查容量已更新，排不完的件顺延到之后季度')
}

async function handleRepack(): Promise<void> {
  const count = await cycleStore.repack()
  ElMessage.success(`待检队列已重新编排，共 ${count} 件在排`)
}

function handleFilterChange(key: string, value: string): void {
  if (key === 'treeId') treeFilter.value = value
  if (key === 'type') typeFilter.value = value as SupportType | 'all'
}

function handleTabChange(key: string | number): void {
  if (key === 'standard') syncStandardDraft()
}

/** 台账里是否展示「已由保护级别调整而待重算」标记 */
function staleTip(row: Support): string {
  return treeStore.supportLevelStale(row)
    ? `古树现档为「${levelOf(row)}」，本件档位仍为「${row.cycleLevel}」，下次对账按现档重算`
    : ''
}
</script>

<template>
  <div>
    <div class="stat-row">
      <StatBadge label="加固件总数" :value="rows.length" suffix="件" tone="primary" icon="Histogram" />
      <StatBadge
        label="超期未检查"
        :value="overdueRows.length"
        suffix="件"
        :tone="overdueRows.length > 0 ? 'danger' : 'success'"
        icon="Warning"
        hint="按古树现档级别对应的保护科周期判定"
      />
      <StatBadge
        label="本季度待检"
        :value="cycleStore.pendingByQuarter[quarterNow]?.length ?? 0"
        suffix="件"
        tone="info"
        icon="Calendar"
        :hint="`每季度容量 ${cycleStore.capacity} 件，排不完顺延下一季度`"
      />
      <StatBadge
        label="级别调整待重算"
        :value="staleRows.length"
        suffix="件"
        :tone="staleRows.length > 0 ? 'warning' : 'success'"
        icon="Refresh"
        hint="保护级别刚被保护科改过，下批次对账后按现档周期重排"
      />
      <StatBadge label="覆盖古树" :value="coveredTrees" suffix="株" tone="default" icon="DataLine" size="small" />
    </div>

    <el-alert
      v-if="roleStore.isPatrol()"
      type="info"
      show-icon
      :closable="false"
      class="mb-14"
      title="当前为巡检班视角：加固件台账、周期标准与待检清单由保护科管理，本页仅可查看"
    />
    <el-alert
      v-else-if="overdueRows.length > 0"
      type="warning"
      show-icon
      :closable="false"
      class="mb-14"
      :title="`有 ${overdueRows.length} 件加固件超过检查周期未检查`"
    >
      <template #default>
        <div class="overdue-list">
          <div v-for="row in overdueRows" :key="row.id">
            {{ treeLabel[row.treeId] ?? '（古树已删除）' }} · {{ row.type }}：最近检查
            {{ row.lastCheckDate || '未记录' }}，{{ levelOf(row) }} 保护周期 {{ cycleMon(row) }} 个月，已超期
            {{ overdueDays(row.lastCheckDate, cycleMon(row)) }} 天
          </div>
        </div>
      </template>
    </el-alert>

    <el-tabs v-model="activeTab" class="mb-14" @tab-change="handleTabChange">
      <el-tab-pane label="加固件台账" name="ledger" />
      <el-tab-pane label="待检清单（季度排队）" name="queue" />
      <el-tab-pane label="周期标准与容量" name="standard" />
    </el-tabs>

    <!-- ============================ 台账 ============================ -->
    <el-card v-if="activeTab === 'ledger'" shadow="never">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">支撑加固与避雷件登记（保护科台账）</span>
          <el-button v-if="roleStore.isProtection()" type="primary" @click="openCreate" :disabled="treeStore.trees.length === 0">
            <el-icon><Plus /></el-icon>
            <span>登记加固件</span>
          </el-button>
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
        :result-text="`命中 ${filtered.length} / ${rows.length} 件`"
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
        v-if="rows.length === 0 && !loading"
        title="还没有加固件记录"
        description="由保护科登记支撑杆、拉纤与避雷件；检查周期按古树现档保护级别自动套用周期标准。"
        :action-text="roleStore.isProtection() ? '登记第一件加固件' : ''"
        @action="openCreate"
      />

      <el-table v-else v-loading="loading || !treeStore.ready" :data="filtered" row-key="id" stripe :row-class-name="rowClassName">
        <el-table-column label="古树" min-width="190">
          <template #default="{ row }">
            <div class="cell-stack">
              <span>{{ treeLabel[row.treeId] ?? '（古树已删除）' }}</span>
              <VigorTag :vigor="treeStore.statOf(row.treeId).latestVigor" :trend="treeStore.statOf(row.treeId).latestTrend" size="small" />
            </div>
          </template>
        </el-table-column>
        <el-table-column label="类型" width="100">
          <template #default="{ row }">
            <el-tag :type="row.type === '避雷' ? 'warning' : row.type === '拉纤' ? 'info' : 'success'">{{ row.type }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="installDate" label="安装日期" width="110" />
        <el-table-column label="现档级别" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="levelOf(row) === '一级' ? 'danger' : levelOf(row) === '二级' ? 'warning' : 'info'">
              {{ levelOf(row) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="检查周期" width="150">
          <template #default="{ row }">
            <div class="cell-stack">
              <span>{{ cycleMon(row) }} 个月</span>
              <el-tooltip v-if="staleTip(row)" :content="staleTip(row)" placement="top">
                <el-tag size="small" type="warning" effect="plain">档位 {{ row.cycleLevel }} · 待重算</el-tag>
              </el-tooltip>
              <span v-else class="cell-sub">档位 {{ row.cycleLevel }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="最近检查" width="120">
          <template #default="{ row }">
            <span v-if="row.lastCheckDate === ''" class="cell-warn">未记录</span>
            <span v-else>{{ row.lastCheckDate }}</span>
          </template>
        </el-table-column>
        <el-table-column label="下次到期" width="120">
          <template #default="{ row }">{{ nextCheckDate(row.lastCheckDate, cycleMon(row)) || '—' }}</template>
        </el-table-column>
        <el-table-column label="检查状态" width="160">
          <template #default="{ row }">
            <el-tag v-if="isSupportOverdue(row.lastCheckDate, cycleMon(row))" type="danger" effect="dark">
              超期 {{ overdueDays(row.lastCheckDate, cycleMon(row)) }} 天
            </el-tag>
            <el-tag v-else type="success" effect="light">周期内</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="{ row }">
            <el-button v-if="roleStore.isProtection()" link type="danger" size="small" @click="handleDelete(row)">删除</el-button>
            <span v-else class="cell-sub">保护科维护</span>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- ============================ 待检清单 ============================ -->
    <el-card v-else-if="activeTab === 'queue'" shadow="never">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">
            待检清单 · 每季度容量 {{ cycleStore.capacity }} 件（排不完的顺延下一季度，已查的不再改）
          </span>
          <el-button v-if="roleStore.isProtection()" :loading="cycleStore.saving" @click="handleRepack">立即重排</el-button>
        </div>
      </template>

      <EmptyPanel
        v-if="cycleStore.pendingPlans.length === 0"
        title="待检清单为空"
        description="对账或周期标准变更后会自动按容量重新编排；已查计划在下方历史中保留。"
      />

      <template v-else>
        <div v-for="(plans, quarter) in cycleStore.pendingByQuarter" :key="quarter" class="quarter-block">
          <div class="quarter-head">
            <el-tag :type="quarter === quarterNow ? 'danger' : quarter < quarterNow ? 'warning' : 'info'" effect="dark">
              {{ quarter }}
            </el-tag>
            <span class="cell-sub">{{ plans.length }} / {{ cycleStore.capacity }} 件</span>
          </div>
          <el-table :data="plans" row-key="id" size="small" stripe>
            <el-table-column label="古树 / 加固件" min-width="220">
              <template #default="{ row }">
                <span>{{ treeLabel[planSupport[row.supportId]?.treeId] ?? '（已删除）' }} · {{ planSupport[row.supportId]?.type ?? '—' }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="dueDate" label="到期日期" width="120" />
            <el-table-column label="周期档位" width="170">
              <template #default="{ row }">{{ row.cycleLevel }} · {{ row.checkCycleMon }} 个月</template>
            </el-table-column>
            <el-table-column label="状态" width="100">
              <template #default>
                <el-tag size="small" type="warning">待检</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="140">
              <template #default="{ row }">
                <el-button
                  v-if="roleStore.isProtection()"
                  link
                  type="primary"
                  size="small"
                  @click="handleCheckPlan(row.id)"
                >
                  登记已查
                </el-button>
                <span v-else class="cell-sub">保护科登记</span>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </template>

      <el-divider content-position="left">已查历史（冻结，不再参与重排）</el-divider>
      <el-table :data="cycleStore.checkedPlans" row-key="id" size="small" stripe>
        <el-table-column label="古树 / 加固件" min-width="220">
          <template #default="{ row }">
            <span>{{ treeLabel[planSupport[row.supportId]?.treeId] ?? '（已删除）' }} · {{ planSupport[row.supportId]?.type ?? '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="quarter" label="排入季度" width="110" />
        <el-table-column prop="checkedDate" label="实际检查日期" width="130" />
        <el-table-column label="来源批次" min-width="140">
          <template #default="{ row }">{{ row.sourceBatchId === '' ? '手动登记' : row.sourceBatchId }}</template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- ============================ 周期标准与容量 ============================ -->
    <el-card v-else shadow="never">
      <template #header>
        <span class="card-header__title">周期标准（保护科按保护级别制定）与每季度检查容量</span>
      </template>
      <el-alert
        type="info"
        show-icon
        :closable="false"
        class="mb-14"
        title="巡检班上门发现倾斜超限或空洞高风险，只记入树体检查记录，加固件检查周期照旧排；周期调整仅由保护科在此修改，或在批次对账时按现档级别重算。"
      />
      <el-table :data="standardRows" row-key="level" size="small">
        <el-table-column label="保护级别" width="120">
          <template #default="{ row }">
            <el-tag :type="row.level === '一级' ? 'danger' : row.level === '二级' ? 'warning' : 'info'">{{ row.level }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="检查周期（月）" width="220">
          <template #default="{ row }">
            <el-input-number
              :model-value="standardMonthsOf(row)"
              :min="1"
              :max="120"
              :step="1"
              size="small"
              :disabled="roleStore.isPatrol()"
              @update:model-value="(value: number | undefined) => setStandardMonths(row, value)"
            />
          </template>
        </el-table-column>
        <el-table-column label="操作">
          <template #default="{ row }">
            <el-button
              v-if="roleStore.isProtection()"
              link
              type="primary"
              size="small"
              :loading="cycleStore.saving"
              @click="handleSaveStandard(row.level)"
            >
              保存并重排
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-divider />
      <div class="capacity-row">
        <span>每季度可排检查的加固件容量：</span>
        <el-input-number v-model="capacityDraft" :min="1" :max="999" :step="1" :disabled="roleStore.isPatrol()" />
        <el-button v-if="roleStore.isProtection()" type="primary" :loading="cycleStore.saving" @click="handleSaveCapacity">
          保存容量并重排
        </el-button>
        <span class="cell-sub">超过容量的件自动排到之后季度。</span>
      </div>
    </el-card>

    <el-dialog v-model="dialogVisible" title="登记加固件" width="600px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="120px">
        <el-form-item label="古树" prop="treeId">
          <el-select v-model="form.treeId" filterable style="width: 100%">
            <el-option
              v-for="tree in treeStore.trees"
              :key="tree.id"
              :value="tree.id"
              :label="`${tree.code} · ${tree.species} · ${tree.protectLevel} · ${tree.location}`"
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
          <div class="cell-sub" style="line-height: 1.8">
            正常由检查批次对账回写；仅在登记历史件时手工补录。周期按古树现档「{{
              treeStore.trees.find((tree) => tree.id === form.treeId)?.protectLevel ?? '—'
            }}」保护标准自动套用。
          </div>
        </el-form-item>
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

.overdue-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  line-height: 1.8;
}

.cell-stack {
  display: flex;
  flex-direction: column;
  gap: 4px;
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

.quarter-block {
  margin-bottom: 12px;
}

.quarter-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
}

.capacity-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

:deep(.row-overdue) {
  --el-table-tr-bg-color: #fdf3f2;
}
</style>
