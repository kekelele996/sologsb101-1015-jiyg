/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbheritagetree
 * - 含数据结构版本号与 v1 → v2 → v3 升级迁移逻辑
 * - v3：巡检 / 保护科两侧职责分开
 *   · cycleStandards：保护科按保护级别制定的加固件检查周期标准
 *   · appSettings：每季度检查容量等键值设置
 *   · surveyBatches：树体检查批次（草稿 / 已交回 / 已退回 / 已对账）
 *   · supportCheckPlans：加固件待检计划（季度容量排队，查完的不再改）
 *   · surveys 增加 batchId / protectLevelSnapshot；supports 以 cycleLevel 取代逐件周期
 * - 提供各表增删改查、批次交回 / 整批退回 / 对账、待检队列重排、整库快照导入导出与重置
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie'
import type { Tree, ProtectLevel } from '../types/tree'
import type { Survey } from '../types/survey'
import type { Measure, MeasureState } from '../types/measure'
import type { Support } from '../types/support'
import type { Review } from '../types/review'
import type { CycleStandard } from '../types/cycle'
import { DEFAULT_CYCLE_STANDARDS, DEFAULT_QUARTER_CAPACITY, SETTING_QUARTER_CAPACITY } from '../types/cycle'
import type { SurveyBatch } from '../types/batch'
import type { SupportCheckPlan } from '../types/plan'
import { nowIso, today, uuid } from './id'
import { seedDatabase } from './seed'
import { cycleMonthsOf, packByQuarterCapacity, quarterOf, supportDueDate, type PackItem } from './cycle'

/** 数据库名 */
export const DB_NAME = 'gbheritagetree'

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3

/** 数据行结构修订号 */
export const ROW_REVISION = 3

/** 键值设置表行 */
export interface AppSetting {
  id: string
  value: number
  updatedAt: string
}

class HeritageTreeDatabase extends Dexie {
  trees!: Table<Tree, string>
  surveys!: Table<Survey, string>
  measures!: Table<Measure, string>
  supports!: Table<Support, string>
  reviews!: Table<Review, string>
  cycleStandards!: Table<CycleStandard, string>
  appSettings!: Table<AppSetting, string>
  surveyBatches!: Table<SurveyBatch, string>
  supportCheckPlans!: Table<SupportCheckPlan, string>

  constructor() {
    super(DB_NAME)

    // ---------- v1：初版结构 ----------
    this.version(1).stores({
      trees: 'id, code, species, protectLevel, ageYears, createdAt',
      surveys: 'id, treeId, date',
      measures: 'id, treeId, type, state, date',
      supports: 'id, treeId, type, installDate',
      reviews: 'id, treeId, date, vigor',
    })

    // ---------- v2：补齐索引与回写字段，并迁移历史数据 ----------
    this.version(2).stores({
      trees: 'id, code, species, protectLevel, ageYears, createdAt, updatedAt, owner',
      // 复合索引 [treeId+date]：按古树 + 日期快速取检查记录
      surveys: 'id, treeId, [treeId+date], date, siteNote',
      measures: 'id, treeId, type, state, date, operator',
      supports: 'id, treeId, type, installDate, lastCheckDate',
      reviews: 'id, treeId, date, vigor, trend',
    })

    // ---------- v3：两侧职责分开 —— 周期标准 / 批次 / 待检队列 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        trees: 'id, code, species, protectLevel, ageYears, createdAt, updatedAt, owner',
        surveys: 'id, treeId, [treeId+date], date, siteNote, batchId',
        measures: 'id, treeId, type, state, date, operator',
        supports: 'id, treeId, type, installDate, lastCheckDate',
        reviews: 'id, treeId, date, vigor, trend',
        cycleStandards: 'id',
        appSettings: 'id',
        surveyBatches: 'id, status, visitDate',
        supportCheckPlans: 'id, supportId, treeId, quarter, status',
      })
      .upgrade(async (tx) => {
        // 迁移 1：既有表补齐修订号
        const tables = [
          tx.table('trees'),
          tx.table('surveys'),
          tx.table('measures'),
          tx.table('supports'),
          tx.table('reviews'),
        ]
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso()
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt
          })
        }
        // 迁移 2：古树补齐「最近复壮日期」
        await tx.table('trees').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.lastMeasureDate !== 'string') row.lastMeasureDate = ''
        })
        // 迁移 3：复评补齐「后续措施」
        await tx.table('reviews').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.followUp !== 'string') row.followUp = ''
        })
        // 迁移 4：巡检记录补齐批次归属与级别快照（存量记录视为未交回）
        await tx.table('surveys').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.batchId !== 'string') row.batchId = ''
          if (typeof row.protectLevelSnapshot !== 'string') row.protectLevelSnapshot = ''
        })

        // 迁移 5：加固件周期档位回填 —— 缺周期档位的，升级时按现有档案（古树现档级别）回填
        const treeRows = (await tx.table('trees').toArray()) as Tree[]
        const levelOf = (treeId: string): ProtectLevel =>
          treeRows.find((tree) => tree.id === treeId)?.protectLevel ?? '三级'
        await tx.table('supports').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.cycleLevel !== 'string') {
            row.cycleLevel = levelOf(String(row.treeId ?? ''))
          }
          // 逐件手填周期作废：周期一律按保护科周期标准 + 现档级别派生
          delete row.checkCycleMon
          if (typeof row.lastCheckDate !== 'string') row.lastCheckDate = ''
        })

        // 迁移 6：写入默认周期标准与默认季度容量（已存在则不覆盖）
        const standardRows = (await tx.table('cycleStandards').toArray()) as CycleStandard[]
        const stamp = nowIso()
        for (const level of ['一级', '二级', '三级'] as ProtectLevel[]) {
          if (!standardRows.some((row) => row.id === level)) {
            await tx.table('cycleStandards').add({
              id: level,
              checkCycleMon: DEFAULT_CYCLE_STANDARDS[level],
              createdAt: stamp,
              updatedAt: stamp,
              revision: ROW_REVISION,
            } satisfies CycleStandard)
          }
        }
        const settingRows = (await tx.table('appSettings').toArray()) as AppSetting[]
        if (!settingRows.some((row) => row.id === SETTING_QUARTER_CAPACITY)) {
          await tx.table('appSettings').add({
            id: SETTING_QUARTER_CAPACITY,
            value: DEFAULT_QUARTER_CAPACITY,
            updatedAt: stamp,
          } satisfies AppSetting)
        }

        // 迁移 7：按当前周期标准与容量，为全部加固件生成初始待检计划
        const standards = (await tx.table('cycleStandards').toArray()) as CycleStandard[]
        const capacity =
          (settingRows.find((row) => row.id === SETTING_QUARTER_CAPACITY)?.value as number | undefined) ??
          DEFAULT_QUARTER_CAPACITY
        const supports = (await tx.table('supports').toArray()) as Support[]
        const packItems: PackItem[] = supports.map((support) => {
          const level = levelOf(support.treeId)
          const months = cycleMonthsOf(level, standards)
          return {
            supportId: support.id,
            treeId: support.treeId,
            dueDate: supportDueDate(support, months),
            cycleLevel: level,
            checkCycleMon: months,
          }
        })
        const packed = packByQuarterCapacity(packItems, capacity, quarterOf(today()))
        for (const item of packed) {
          await tx.table('supportCheckPlans').add({
            id: uuid('plan'),
            supportId: item.supportId,
            treeId: item.treeId,
            quarter: item.quarter,
            dueDate: item.dueDate,
            cycleLevel: item.cycleLevel,
            checkCycleMon: item.checkCycleMon,
            status: '待检',
            checkedDate: '',
            sourceBatchId: '',
            createdAt: stamp,
            updatedAt: stamp,
            revision: ROW_REVISION,
          } satisfies SupportCheckPlan)
        }
      })
  }
}

export const db = new HeritageTreeDatabase()

/* ------------------------------ 初始化与播种 ------------------------------ */

let initPromise: Promise<void> | null = null

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当古树表为空时播种）。
 * 多次调用共用同一个 Promise，避免并发重复播种。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open()
      // 首屏自动播种演示数据：仅当古树表为空时执行（幂等）
      if ((await db.trees.count()) === 0) {
        await seedDatabase()
      }
    })()
  }
  return initPromise
}

/* -------------------------------- 古树 -------------------------------- */

export async function listTrees(): Promise<Tree[]> {
  const rows = await db.trees.toArray()
  return rows.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
}

export async function getTree(id: string): Promise<Tree | undefined> {
  return db.trees.get(id)
}

export async function putTree(row: Tree): Promise<void> {
  await db.trees.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

/** 删除古树并级联清理其检查、措施、加固、待检计划与批次引用 */
export async function removeTree(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.trees, db.surveys, db.measures, db.supports, db.reviews, db.supportCheckPlans, db.surveyBatches],
    async () => {
      const surveyIds = (await db.surveys.where('treeId').equals(id).toArray()).map((row) => row.id)
      await db.surveys.where('treeId').equals(id).delete()
      await db.measures.where('treeId').equals(id).delete()
      await db.supportCheckPlans.where('treeId').equals(id).delete()
      const supportIds = (await db.supports.where('treeId').equals(id).toArray()).map((row) => row.id)
      await db.supports.where('treeId').equals(id).delete()
      await db.reviews.where('treeId').equals(id).delete()
      if (supportIds.length > 0) {
        await db.supportCheckPlans.where('supportId').anyOf(supportIds).delete()
      }
      // 批次中摘除该树的检查记录与级别快照（已交回批次原则上不应删树）
      if (surveyIds.length > 0) {
        const batches = await db.surveyBatches.toArray()
        for (const batch of batches) {
          const nextIds = batch.surveyIds.filter((sid) => !surveyIds.includes(sid))
          if (nextIds.length !== batch.surveyIds.length) {
            const snapshot = { ...batch.levelSnapshot }
            delete snapshot[id]
            await db.surveyBatches.put({
              ...batch,
              surveyIds: nextIds,
              levelSnapshot: snapshot,
              updatedAt: nowIso(),
            })
          }
        }
      }
      await db.trees.delete(id)
    },
  )
}

/* ------------------------------ 树体检查 ------------------------------ */

export async function listSurveys(): Promise<Survey[]> {
  const rows = await db.surveys.toArray()
  return rows.sort((a, b) => a.treeId.localeCompare(b.treeId) || a.date.localeCompare(b.date))
}

export async function listSurveysByTree(treeId: string): Promise<Survey[]> {
  const rows = await db.surveys.where('treeId').equals(treeId).toArray()
  return rows.sort((a, b) => a.date.localeCompare(b.date))
}

export async function putSurvey(row: Survey): Promise<void> {
  await db.surveys.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

/**
 * 删除检查记录：同时从所属批次（草稿 / 已退回）的明细中摘除，避免批次悬挂引用。
 * 已交回 / 已对账批次的记录由界面层禁止删除。
 */
export async function removeSurvey(id: string): Promise<void> {
  await db.transaction('rw', db.surveys, db.surveyBatches, async () => {
    const survey = await db.surveys.get(id)
    await db.surveys.delete(id)
    if (survey && survey.batchId !== '') {
      const batch = await db.surveyBatches.get(survey.batchId)
      if (batch) {
        await db.surveyBatches.put({
          ...batch,
          surveyIds: batch.surveyIds.filter((sid) => sid !== id),
          updatedAt: nowIso(),
        })
      }
    }
  })
}

/* ------------------------------ 复壮措施 ------------------------------ */

export async function listMeasures(): Promise<Measure[]> {
  const rows = await db.measures.toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function listMeasuresByTree(treeId: string): Promise<Measure[]> {
  const rows = await db.measures.where('treeId').equals(treeId).toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

/**
 * 写入复壮措施。
 * 措施状态为「已完成」时，回写古树的最近复壮日期（仅当本次日期更新时）。
 */
export async function putMeasure(row: Measure): Promise<void> {
  await db.transaction('rw', db.trees, db.measures, async () => {
    await db.measures.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
    if (row.state !== '已完成') return
    const tree = await db.trees.get(row.treeId)
    if (!tree) return
    if (tree.lastMeasureDate >= row.date) return
    await db.trees.update(tree.id, { lastMeasureDate: row.date, updatedAt: nowIso() })
  })
}

export async function removeMeasure(id: string): Promise<void> {
  await db.measures.delete(id)
}

/** 批量修改措施状态；改为「已完成」时同步回写古树最近复壮日期 */
export async function batchSetMeasureState(ids: string[], state: MeasureState): Promise<number> {
  if (ids.length === 0) return 0
  const rows = await db.measures.bulkGet(ids)
  const list = rows.filter((row): row is Measure => row !== undefined)
  for (const row of list) {
    await putMeasure({ ...row, state })
  }
  return list.length
}

/* ------------------------------ 加固件 ------------------------------ */

export async function listSupports(): Promise<Support[]> {
  const rows = await db.supports.toArray()
  return rows.sort((a, b) => a.installDate.localeCompare(b.installDate))
}

export async function listSupportsByTree(treeId: string): Promise<Support[]> {
  return db.supports.where('treeId').equals(treeId).toArray()
}

/**
 * 写入加固件。属保护科台账：周期档位取所属古树现档保护级别，
 * 具体周期月数由周期标准派生，加固件本身不保存周期月数。
 */
export async function putSupport(row: Support): Promise<void> {
  await db.supports.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

/** 新建加固件时按古树现档级别确定周期档位 */
export async function resolveSupportCycleLevel(treeId: string): Promise<ProtectLevel> {
  const tree = await db.trees.get(treeId)
  return tree?.protectLevel ?? '三级'
}

export async function removeSupport(id: string): Promise<void> {
  await db.transaction('rw', db.supports, db.supportCheckPlans, async () => {
    await db.supportCheckPlans.where('supportId').equals(id).delete()
    await db.supports.delete(id)
  })
}

/* ----------------------------- 周期标准 ----------------------------- */

export async function listCycleStandards(): Promise<CycleStandard[]> {
  const rows = await db.cycleStandards.toArray()
  return rows.sort((a, b) => a.id.localeCompare(b.id, 'zh-Hans-CN'))
}

/** 取生效周期标准映射（缺档回退默认值） */
export async function cycleStandardMap(): Promise<Record<ProtectLevel, number>> {
  const rows = await db.cycleStandards.toArray()
  return {
    一级: cycleMonthsOf('一级', rows),
    二级: cycleMonthsOf('二级', rows),
    三级: cycleMonthsOf('三级', rows),
  }
}

export async function putCycleStandard(level: ProtectLevel, checkCycleMon: number): Promise<void> {
  const existing = await db.cycleStandards.get(level)
  await db.cycleStandards.put({
    id: level,
    checkCycleMon,
    createdAt: existing?.createdAt ?? nowIso(),
    updatedAt: nowIso(),
    revision: ROW_REVISION,
  })
}

/* ------------------------------ 键值设置 ------------------------------ */

export async function getQuarterCapacity(): Promise<number> {
  const row = await db.appSettings.get(SETTING_QUARTER_CAPACITY)
  return row && row.value > 0 ? row.value : DEFAULT_QUARTER_CAPACITY
}

export async function setQuarterCapacity(value: number): Promise<void> {
  await db.appSettings.put({ id: SETTING_QUARTER_CAPACITY, value, updatedAt: nowIso() })
}

/* ------------------------------ 检查批次 ------------------------------ */

export async function listBatches(): Promise<SurveyBatch[]> {
  const rows = await db.surveyBatches.toArray()
  return rows.sort((a, b) => b.visitDate.localeCompare(a.visitDate))
}

export async function putBatch(row: SurveyBatch): Promise<void> {
  await db.surveyBatches.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

export async function getBatch(id: string): Promise<SurveyBatch | undefined> {
  return db.surveyBatches.get(id)
}

export async function removeBatch(id: string): Promise<void> {
  await db.transaction('rw', db.surveyBatches, db.surveys, async () => {
    const batch = await db.surveyBatches.get(id)
    if (batch && batch.status !== '已交回' && batch.status !== '已对账') {
      // 草稿 / 已退回批次删除时，明细记录退回「未交回」
      for (const sid of batch.surveyIds) {
        await db.surveys.update(sid, { batchId: '', updatedAt: nowIso() })
      }
    }
    await db.surveyBatches.delete(id)
  })
}

/** 把未交回的检查记录加入草稿批次 */
export async function attachSurveysToBatch(batchId: string, surveyIds: string[]): Promise<void> {
  await db.transaction('rw', db.surveyBatches, db.surveys, async () => {
    const batch = await db.surveyBatches.get(batchId)
    if (!batch || (batch.status !== '草稿' && batch.status !== '已退回')) {
      throw new Error('只有草稿 / 已退回批次可以增删检查记录')
    }
    const merged = Array.from(new Set([...batch.surveyIds, ...surveyIds]))
    await db.surveyBatches.put({ ...batch, surveyIds: merged, updatedAt: nowIso() })
    for (const sid of surveyIds) {
      await db.surveys.update(sid, { batchId, updatedAt: nowIso() })
    }
  })
}

/** 从批次摘除一条检查记录（记录本身保留，回到未交回） */
export async function detachSurveyFromBatch(batchId: string, surveyId: string): Promise<void> {
  await db.transaction('rw', db.surveyBatches, db.surveys, async () => {
    const batch = await db.surveyBatches.get(batchId)
    if (!batch || (batch.status !== '草稿' && batch.status !== '已退回')) {
      throw new Error('只有草稿 / 已退回批次可以增删检查记录')
    }
    await db.surveyBatches.put({
      ...batch,
      surveyIds: batch.surveyIds.filter((id) => id !== surveyId),
      updatedAt: nowIso(),
    })
    await db.surveys.update(surveyId, { batchId: '', updatedAt: nowIso() })
  })
}

/** 巡检班交回批次：回齐（条数 = 计划株数）才允许交回，并冻结明细 */
export async function submitBatch(batchId: string): Promise<void> {
  await db.transaction('rw', db.surveyBatches, db.surveys, db.trees, async () => {
    const batch = await db.surveyBatches.get(batchId)
    if (!batch) throw new Error('批次不存在')
    if (batch.status !== '草稿' && batch.status !== '已退回') {
      throw new Error('只有草稿 / 已退回批次可以交回')
    }
    if (batch.surveyIds.length === 0) throw new Error('批次内还没有检查记录，不能交回')
    if (batch.surveyIds.length !== batch.plannedCount) {
      throw new Error(`本批计划检查 ${batch.plannedCount} 株，实际 ${batch.surveyIds.length} 条，交齐后才能交回`)
    }
    const surveys = await db.surveys.bulkGet(batch.surveyIds)
    if (surveys.some((row) => row === undefined)) throw new Error('批次内存在已被删除的检查记录，请先整理批次')
    // 巡检带回的旧级别：交回时按当时档案快照到每条记录与批次上，对账时不采用
    const trees = await db.trees.bulkGet(Array.from(new Set(surveys.map((row) => row!.treeId))))
    const levelOf = new Map(trees.filter((t): t is Tree => t !== undefined).map((tree) => [tree.id, tree.protectLevel]))
    const snapshot: Record<string, ProtectLevel> = { ...batch.levelSnapshot }
    for (const survey of surveys) {
      if (!survey) continue
      const level = levelOf.get(survey.treeId) ?? survey.protectLevelSnapshot
      const snapshotLevel = (level === '' ? '三级' : level) as ProtectLevel
      snapshot[survey.treeId] = snapshotLevel
      await db.surveys.update(survey.id, {
        batchId,
        protectLevelSnapshot: snapshotLevel,
        updatedAt: nowIso(),
      })
    }
    await db.surveyBatches.put({
      ...batch,
      status: '已交回',
      levelSnapshot: snapshot,
      returnReason: '',
      submittedAt: nowIso(),
      updatedAt: nowIso(),
    })
  })
}

/**
 * 保护科整批退回：
 * 有一条不对就整批退回；保护科一侧（加固件台账 / 周期 / 待检清单）一律不动，
 * 仅批次置为已退回并解锁明细，由巡检班修正后重新交回。
 */
export async function returnBatch(batchId: string, reason: string): Promise<void> {
  const batch = await db.surveyBatches.get(batchId)
  if (!batch) throw new Error('批次不存在')
  if (batch.status !== '已交回') throw new Error('只有已交回的批次可以退回')
  const text = reason.trim()
  if (text === '') throw new Error('整批退回必须填写退回原因')
  await db.transaction('rw', db.surveyBatches, async () => {
    await db.surveyBatches.put({
      ...batch,
      status: '已退回',
      returnReason: text,
      updatedAt: nowIso(),
    })
  })
}

/* --------------------------- 待检队列与对账 --------------------------- */

export interface ReconcileResult {
  coveredTreeIds: string[]
  updatedSupportIds: string[]
  repacked: SupportCheckPlan[]
}

/**
 * 批次对账（保护科）。
 * 前置：批次已交回且交齐；对账过程：
 * 1. 保护级别一律取古树现档（巡检带回的旧级别仅展示，不参与计算）；
 * 2. 覆盖到的加固件：最近检查日期 = 批次内该树最新检查日期，周期档位刷新为现档级别，
 *    原待检计划作废；
 * 3. 全部待检计划按保护科周期标准与每季度容量重新装箱排队（已查 / 已作废历史不动）；
 * 4. 批次置为已对账，明细保持锁定。
 */
export async function reconcileBatch(
  batchId: string,
  reference = today(),
): Promise<ReconcileResult> {
  return db.transaction(
    'rw',
    [db.surveyBatches, db.surveys, db.supports, db.supportCheckPlans, db.trees, db.cycleStandards, db.appSettings],
    async () => {
      const batch = await db.surveyBatches.get(batchId)
      if (!batch) throw new Error('批次不存在')
      if (batch.status !== '已交回') throw new Error('只有已交回的批次可以对账')
      if (batch.surveyIds.length !== batch.plannedCount) {
        throw new Error(`检查记录尚未交齐（${batch.surveyIds.length}/${batch.plannedCount}），不能对账`)
      }
      const surveys = await db.surveys.bulkGet(batch.surveyIds)
      if (surveys.some((row) => row === undefined)) throw new Error('批次内存在已被删除的检查记录')
      const validSurveys = surveys.filter((row): row is Survey => row !== undefined)

      // 批次内每株古树的最新检查日期
      const latestDateByTree = new Map<string, string>()
      const coveredSet = new Set<string>()
      for (const survey of validSurveys) {
        coveredSet.add(survey.treeId)
        const prev = latestDateByTree.get(survey.treeId)
        if (prev === undefined || survey.date > prev) latestDateByTree.set(survey.treeId, survey.date)
      }

      // 现档为准：级别、周期标准都从保护科数据读取
      const treeRows = await db.trees.bulkGet(Array.from(coveredSet))
      const levelByTree = new Map<string, ProtectLevel>()
      treeRows.forEach((tree) => {
        if (tree) levelByTree.set(tree.id, tree.protectLevel)
      })

      // 覆盖到的加固件：回写最新检查日期、刷新周期档位、作废旧待检计划
      const coveredSupports = await db.supports.where('treeId').anyOf(Array.from(coveredSet)).toArray()
      const updatedSupportIds: string[] = []
      for (const support of coveredSupports) {
        const level = levelByTree.get(support.treeId)
        if (level === undefined) continue
        const latestDate = latestDateByTree.get(support.treeId) ?? support.lastCheckDate
        await db.supports.put({
          ...support,
          lastCheckDate: latestDate,
          cycleLevel: level,
          updatedAt: nowIso(),
          revision: ROW_REVISION,
        })
        const activePlans = await db.supportCheckPlans
          .where('supportId')
          .equals(support.id)
          .filter((plan) => plan.status === '待检')
          .toArray()
        for (const plan of activePlans) {
          await db.supportCheckPlans.put({ ...plan, status: '已作废', updatedAt: nowIso() })
        }
        updatedSupportIds.push(support.id)
      }

      // 全部待检计划按现档周期 + 容量重新排队（查完的历史不再改）
      const repacked = await packAndReplacePendingPlans(reference)

      await db.surveyBatches.put({
        ...batch,
        status: '已对账',
        reconciledAt: nowIso(),
        updatedAt: nowIso(),
      })

      return { coveredTreeIds: Array.from(coveredSet), updatedSupportIds, repacked }
    },
  )
}

/**
 * 全量重排待检队列：删除所有「待检」计划，
 * 按每件加固件的现档级别周期与到期日、季度容量重新装箱。
 * 已查 / 已作废的历史计划保持不动。
 */
export async function rebuildPendingPlans(reference = today()): Promise<SupportCheckPlan[]> {
  return db.transaction('rw', [db.supportCheckPlans, db.supports, db.trees, db.cycleStandards], async () => {
    return packAndReplacePendingPlans(reference)
  })
}

/**
 * 重排核心（不开事务，供对账等外层事务复用）：
 * 读取全部加固件 / 古树 / 周期标准 / 容量，删除现有「待检」计划并按容量重新装箱。
 * 已查 / 已作废历史不动。
 */
async function packAndReplacePendingPlans(reference: string): Promise<SupportCheckPlan[]> {
  const [supports, trees, standards, capacity] = await Promise.all([
    db.supports.toArray(),
    db.trees.toArray(),
    db.cycleStandards.toArray(),
    getQuarterCapacity(),
  ])
  const levelOf = new Map(trees.map((tree) => [tree.id, tree.protectLevel]))
  const packItems: PackItem[] = supports.map((support) => {
    const level = levelOf.get(support.treeId) ?? support.cycleLevel
    const months = cycleMonthsOf(level, standards)
    return {
      supportId: support.id,
      treeId: support.treeId,
      dueDate: supportDueDate(support, months),
      cycleLevel: level,
      checkCycleMon: months,
    }
  })
  const packed = packByQuarterCapacity(packItems, capacity, quarterOf(reference))

  await db.supportCheckPlans.where('status').equals('待检').delete()
  const stamp = nowIso()
  const plans: SupportCheckPlan[] = packed.map((item) => ({
    id: uuid('plan'),
    supportId: item.supportId,
    treeId: item.treeId,
    quarter: item.quarter,
    dueDate: item.dueDate,
    cycleLevel: item.cycleLevel,
    checkCycleMon: item.checkCycleMon,
    status: '待检',
    checkedDate: '',
    sourceBatchId: '',
    createdAt: stamp,
    updatedAt: stamp,
    revision: ROW_REVISION,
  }))
  await db.supportCheckPlans.bulkPut(plans)
  return plans
}

export async function listPlans(): Promise<SupportCheckPlan[]> {
  const rows = await db.supportCheckPlans.toArray()
  return rows.sort((a, b) => a.quarter.localeCompare(b.quarter) || a.dueDate.localeCompare(b.dueDate))
}

/**
 * 登记某条待检计划已完成检查（保护科）：
 * 该计划冻结为已查（查完的不再改），加固件最近检查日期推进到检查日，
 * 随后全量重排，新周期的待检计划重新进队列。
 */
export async function markPlanChecked(planId: string, date = today()): Promise<void> {
  await db.transaction(
    'rw',
    [db.supportCheckPlans, db.supports, db.trees, db.cycleStandards],
    async () => {
      const plan = await db.supportCheckPlans.get(planId)
      if (!plan) throw new Error('待检计划不存在')
      if (plan.status !== '待检') throw new Error('该计划已不在待检队列')
      await db.supportCheckPlans.put({
        ...plan,
        status: '已查',
        checkedDate: date,
        updatedAt: nowIso(),
      })
      const support = await db.supports.get(plan.supportId)
      if (support && date >= support.lastCheckDate) {
        await db.supports.put({ ...support, lastCheckDate: date, updatedAt: nowIso() })
      }
      // 同事务内重排，新周期的待检计划重新排队；刚查完的历史保持「已查」
      await packAndReplacePendingPlans(date)
    },
  )
}

/* ------------------------------ 长势复评 ------------------------------ */

export async function listReviews(): Promise<Review[]> {
  const rows = await db.reviews.toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function listReviewsByTree(treeId: string): Promise<Review[]> {
  const rows = await db.reviews.where('treeId').equals(treeId).toArray()
  return rows.sort((a, b) => a.date.localeCompare(b.date))
}

export async function putReview(row: Review): Promise<void> {
  await db.reviews.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

export async function removeReview(id: string): Promise<void> {
  await db.reviews.delete(id)
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string
  schemaVersion: number
  exportedAt: string
  trees: Tree[]
  surveys: Survey[]
  measures: Measure[]
  supports: Support[]
  reviews: Review[]
  cycleStandards: CycleStandard[]
  appSettings: AppSetting[]
  surveyBatches: SurveyBatch[]
  supportCheckPlans: SupportCheckPlan[]
}

/** 导出整库快照 */
export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [trees, surveys, measures, supports, reviews, cycleStandards, appSettings, surveyBatches, supportCheckPlans] =
    await Promise.all([
      db.trees.toArray(),
      db.surveys.toArray(),
      db.measures.toArray(),
      db.supports.toArray(),
      db.reviews.toArray(),
      db.cycleStandards.toArray(),
      db.appSettings.toArray(),
      db.surveyBatches.toArray(),
      db.supportCheckPlans.toArray(),
    ])
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    trees,
    surveys,
    measures,
    supports,
    reviews,
    cycleStandards,
    appSettings,
    surveyBatches,
    supportCheckPlans,
  }
}

/** 用快照覆盖整库（导入存档）；导入后按现档周期重排一次待检队列 */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.trees,
      db.surveys,
      db.measures,
      db.supports,
      db.reviews,
      db.cycleStandards,
      db.appSettings,
      db.surveyBatches,
      db.supportCheckPlans,
    ],
    async () => {
      await Promise.all([
        db.trees.clear(),
        db.surveys.clear(),
        db.measures.clear(),
        db.supports.clear(),
        db.reviews.clear(),
        db.cycleStandards.clear(),
        db.appSettings.clear(),
        db.surveyBatches.clear(),
        db.supportCheckPlans.clear(),
      ])
      // 归一化 v1/v2 旧存档缺失的 v3 字段：保护级别按古树现档回填
      const treeLevel = new Map(snapshot.trees.map((tree) => [tree.id, tree.protectLevel]))
      await db.trees.bulkPut(
        snapshot.trees.map((row) => ({ ...row, lastMeasureDate: row.lastMeasureDate ?? '', revision: ROW_REVISION })),
      )
      await db.surveys.bulkPut(
        snapshot.surveys.map((row) => ({
          ...row,
          protectLevelSnapshot: typeof row.protectLevelSnapshot === 'string' ? row.protectLevelSnapshot : '',
          batchId: typeof row.batchId === 'string' ? row.batchId : '',
          revision: ROW_REVISION,
        })),
      )
      await db.measures.bulkPut(snapshot.measures.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.supports.bulkPut(
        snapshot.supports.map((row) => {
          const legacy = row as unknown as Partial<Support> & { checkCycleMon?: unknown }
          return {
            ...row,
            cycleLevel: legacy.cycleLevel ?? treeLevel.get(row.treeId) ?? ('三级' as ProtectLevel),
            lastCheckDate: typeof legacy.lastCheckDate === 'string' ? legacy.lastCheckDate : '',
            revision: ROW_REVISION,
          } as Support
        }),
      )
      await db.reviews.bulkPut(
        snapshot.reviews.map((row) => ({
          ...row,
          followUp: typeof row.followUp === 'string' ? row.followUp : '',
          revision: ROW_REVISION,
        })),
      )
      if (Array.isArray(snapshot.cycleStandards) && snapshot.cycleStandards.length > 0) {
        await db.cycleStandards.bulkPut(snapshot.cycleStandards.map((row) => ({ ...row, revision: ROW_REVISION })))
      } else {
        const stamp = nowIso()
        await db.cycleStandards.bulkPut(
          (['一级', '二级', '三级'] as ProtectLevel[]).map(
            (level): CycleStandard => ({
              id: level,
              checkCycleMon: DEFAULT_CYCLE_STANDARDS[level],
              createdAt: stamp,
              updatedAt: stamp,
              revision: ROW_REVISION,
            }),
          ),
        )
      }
      if (Array.isArray(snapshot.appSettings) && snapshot.appSettings.length > 0) {
        await db.appSettings.bulkPut(snapshot.appSettings)
      } else {
        await db.appSettings.put({
          id: SETTING_QUARTER_CAPACITY,
          value: DEFAULT_QUARTER_CAPACITY,
          updatedAt: nowIso(),
        })
      }
      if (Array.isArray(snapshot.surveyBatches)) {
        await db.surveyBatches.bulkPut(snapshot.surveyBatches.map((row) => ({ ...row, revision: ROW_REVISION })))
      }
      // 旧存档没有待检计划：导入后统一按现档重排，因此这里直接丢弃旧计划并由 rebuild 重建
      if (Array.isArray(snapshot.supportCheckPlans) && snapshot.supportCheckPlans.length > 0) {
        await db.supportCheckPlans.bulkPut(
          snapshot.supportCheckPlans.map((row) => ({ ...row, revision: ROW_REVISION })),
        )
      }
    },
  )
  // 周期标准 / 容量以导入档为准，待检队列统一按现档重排，保证容量约束一致
  await rebuildPendingPlans()
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.trees,
      db.surveys,
      db.measures,
      db.supports,
      db.reviews,
      db.cycleStandards,
      db.appSettings,
      db.surveyBatches,
      db.supportCheckPlans,
    ],
    async () => {
      await Promise.all([
        db.trees.clear(),
        db.surveys.clear(),
        db.measures.clear(),
        db.supports.clear(),
        db.reviews.clear(),
        db.cycleStandards.clear(),
        db.appSettings.clear(),
        db.surveyBatches.clear(),
        db.supportCheckPlans.clear(),
      ])
    },
  )
  await seedDatabase()
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [trees, surveys, measures, supports, reviews, cycleStandards, surveyBatches, supportCheckPlans] =
    await Promise.all([
      db.trees.count(),
      db.surveys.count(),
      db.measures.count(),
      db.supports.count(),
      db.reviews.count(),
      db.cycleStandards.count(),
      db.surveyBatches.count(),
      db.supportCheckPlans.count(),
    ])
  return { trees, surveys, measures, supports, reviews, cycleStandards, surveyBatches, supportCheckPlans }
}
