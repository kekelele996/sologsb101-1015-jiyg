/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbheritagetree
 * - 含数据结构版本号与 v1 → v2 → v3 升级迁移逻辑（升级时按 version().stores() 补齐索引）
 * - 提供各表增删改查、整库快照导入导出与重置
 * 纯前端应用：不依赖任何后端服务或外部接口。
 *
 * v3 职责拆分：
 * - 巡检班只写「树体检查」与「加固件检查批次」（待对账 / 已退回 / 已对账）；
 * - 保护科管「加固件台账、周期标准、每季度容量、长势复评结论」；
 *   周期由古树现档保护级别定档，批次整批校验、整批退回、回齐后对账重算。
 */
import Dexie, { type Table } from 'dexie'
import type { Tree } from '../types/tree'
import type { Survey } from '../types/survey'
import type { Measure, MeasureState } from '../types/measure'
import type { Support } from '../types/support'
import type { Review } from '../types/review'
import type { CycleStandard, CycleTier } from '../types/cycle'
import type { InspectionBatch } from '../types/inspection'
import type { AppSetting } from '../types/setting'
import {
  DEFAULT_CYCLE_MONTHS,
  DEFAULT_QUARTER_CAPACITY,
} from '../types/cycle'
import { SETTING_ID } from '../types/setting'
import { nowIso } from './id'
import { seedDatabase } from './seed'

/** 数据库名 */
export const DB_NAME = 'gbheritagetree'

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3

/** 数据行结构修订号 */
export const ROW_REVISION = 3

class HeritageTreeDatabase extends Dexie {
  trees!: Table<Tree, string>
  surveys!: Table<Survey, string>
  measures!: Table<Measure, string>
  supports!: Table<Support, string>
  reviews!: Table<Review, string>
  /** 保护科：按保护级别发布的加固件检查周期标准 */
  cycleStandards!: Table<CycleStandard, string>
  /** 巡检班：加固件检查上报批次 */
  inspectionBatches!: Table<InspectionBatch, string>
  /** 保护科：全局设置（每季度检查容量等，单行） */
  settings!: Table<AppSetting, string>

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
    this.version(2)
      .stores({
        trees: 'id, code, species, protectLevel, ageYears, createdAt, updatedAt, owner',
        // 复合索引 [treeId+date]：按古树 + 日期快速取检查记录
        surveys: 'id, treeId, [treeId+date], date, siteNote',
        measures: 'id, treeId, type, state, date, operator',
        supports: 'id, treeId, type, installDate, lastCheckDate',
        reviews: 'id, treeId, date, vigor, trend',
      })
      .upgrade(async (tx) => {
        // 迁移 1：补齐 revision / createdAt / updatedAt
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
        // 迁移 4：加固件补齐「最近检查日期」
        await tx.table('supports').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.lastCheckDate !== 'string') row.lastCheckDate = ''
          if (typeof row.checkCycleMon !== 'number') row.checkCycleMon = 12
        })
      })

    // ---------- v3：巡检 / 保护科职责拆分 ----------
    // - 新增周期标准表、检查批次表、全局设置表；
    // - 加固件增加 scheduledQuarter（季度排期）索引；
    // - 已有数据缺周期档位的，按现有档案的保护级别回填标准与台账周期。
    this.version(DB_SCHEMA_VERSION)
      .stores({
        trees: 'id, code, species, protectLevel, ageYears, createdAt, updatedAt, owner',
        surveys: 'id, treeId, [treeId+date], date, siteNote',
        measures: 'id, treeId, type, state, date, operator',
        supports: 'id, treeId, type, installDate, lastCheckDate, scheduledQuarter',
        reviews: 'id, treeId, date, vigor, trend',
        cycleStandards: 'id',
        inspectionBatches: 'id, quarter, state',
        settings: 'id',
      })
      .upgrade(async (tx) => {
        const stamp = nowIso()

        // 迁移 1：按现有档案回填周期档位标准（缺哪档补哪档，已有档位不覆盖）
        const standards = await tx.table('cycleStandards').toArray()
        const existing = new Set(standards.map((row: { id?: unknown }) => String(row.id)))
        const seedStandards: CycleStandard[] = (['一级', '二级', '三级'] as CycleTier[])
          .filter((tier) => !existing.has(tier))
          .map((tier) => ({
            id: tier,
            checkCycleMon: DEFAULT_CYCLE_MONTHS[tier],
            createdAt: stamp,
            updatedAt: stamp,
            revision: ROW_REVISION,
          }))
        await tx.table('cycleStandards').bulkPut(seedStandards)

        // 迁移 2：已有加固件缺周期档位的，按古树现档保护级别回填周期
        const standardMap = new Map<CycleTier, number>()
        ;(await tx.table<CycleStandard>('cycleStandards').toArray()).forEach((row) => {
          standardMap.set(row.id, row.checkCycleMon)
        })
        const trees = await tx.table<Tree>('trees').toArray()
        const treeMap = new Map(trees.map((tree) => [tree.id, tree]))
        await tx.table('supports').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.scheduledQuarter !== 'string') row.scheduledQuarter = ''
          if (typeof row.reconciledAt !== 'string') row.reconciledAt = ''
          const tree = treeMap.get(String(row.treeId))
          const cycle = tree ? standardMap.get(tree.protectLevel as CycleTier) : undefined
          // 已有数据缺周期档位（非正数）时才按现档回填，保留历史上明确录入的合法周期
          if (cycle !== undefined && (typeof row.checkCycleMon !== 'number' || row.checkCycleMon <= 0)) {
            row.checkCycleMon = cycle
          }
        })

        // 迁移 3：全局设置缺省（每季度检查容量）
        // 同时对早期可能漏填的回写字段做一次防御性补齐
        await tx.table('trees').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.lastMeasureDate !== 'string') row.lastMeasureDate = ''
        })
        await tx.table('reviews').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.followUp !== 'string') row.followUp = ''
        })
        const settingCount = await tx.table('settings').count()
        if (settingCount === 0) {
          await tx.table('settings').put({
            id: SETTING_ID,
            quarterCapacity: DEFAULT_QUARTER_CAPACITY,
            createdAt: stamp,
            updatedAt: stamp,
            revision: ROW_REVISION,
          } satisfies AppSetting)
        }
      })
  }
}

export const db = new HeritageTreeDatabase()

/* ------------------------------ 初始化与播种 ------------------------------ */

let initPromise: Promise<void> | null = null

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当主表为空时播种）。
 * 多次调用共用同一个 Promise，避免并发重复播种。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open()
      // 保护科基础数据兜底：周期标准、每季度容量（升级 / 导入后都保证存在）
      await ensureBaseline()
      // 首屏自动播种演示数据：仅当主表为空时执行（幂等）
      if ((await db.trees.count()) === 0) {
        await seedDatabase()
      }
    })()
  }
  return initPromise
}

/** 周期标准与全局设置的缺省兜底（幂等） */
export async function ensureBaseline(stamp = nowIso()): Promise<void> {
  const existing = await db.cycleStandards.toArray()
  const have = new Set(existing.map((row) => row.id))
  const missing = (['一级', '二级', '三级'] as CycleTier[]).filter((tier) => !have.has(tier))
  if (missing.length > 0) {
    await db.cycleStandards.bulkPut(
      missing.map((tier) => ({
        id: tier,
        checkCycleMon: DEFAULT_CYCLE_MONTHS[tier],
        createdAt: stamp,
        updatedAt: stamp,
        revision: ROW_REVISION,
      }))
    )
  }
  const setting = await db.settings.get(SETTING_ID)
  if (!setting) {
    await db.settings.put({
      id: SETTING_ID,
      quarterCapacity: DEFAULT_QUARTER_CAPACITY,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    })
  }
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

/** 删除古树并级联清理其检查、措施、加固、复评与检查批次条目 */
export async function removeTree(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.trees, db.surveys, db.measures, db.supports, db.reviews, db.inspectionBatches],
    async () => {
      await db.surveys.where('treeId').equals(id).delete()
      await db.measures.where('treeId').equals(id).delete()
      // 先取该古树名下加固件 id，用于从巡检批次中剔除对应条目
      const supportIds = new Set((await db.supports.where('treeId').equals(id).toArray()).map((row) => row.id))
      await db.supports.where('treeId').equals(id).delete()
      await db.reviews.where('treeId').equals(id).delete()

      if (supportIds.size > 0) {
        const batches = await db.inspectionBatches.toArray()
        for (const batch of batches) {
          const remain = batch.items.filter((item) => !supportIds.has(item.supportId))
          if (remain.length === batch.items.length) continue
          if (remain.length === 0) {
            await db.inspectionBatches.delete(batch.id)
          } else {
            await db.inspectionBatches.update(batch.id, { items: remain, updatedAt: nowIso() })
          }
        }
      }
      await db.trees.delete(id)
    }
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

export async function removeSurvey(id: string): Promise<void> {
  await db.surveys.delete(id)
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

/* ------------------------------ 加固件（保护科台账） ------------------------------ */

export async function listSupports(): Promise<Support[]> {
  const rows = await db.supports.toArray()
  return rows.sort((a, b) => a.installDate.localeCompare(b.installDate))
}

export async function listSupportsByTree(treeId: string): Promise<Support[]> {
  return db.supports.where('treeId').equals(treeId).toArray()
}

export async function putSupport(row: Support): Promise<void> {
  await db.supports.put({
    ...{ scheduledQuarter: '', reconciledAt: '' },
    ...row,
    updatedAt: nowIso(),
    revision: ROW_REVISION,
  })
}

export async function removeSupport(id: string): Promise<void> {
  await db.supports.delete(id)
}

/**
 * 批量落库季度排期：给指定加固件写入排入季度。
 * 仅写入传入的 assignments，不动其它加固件（排不完的继续留在待检清单）。
 */
export async function applyScheduleAssignments(
  assignments: Array<{ id: string; quarter: string }>
): Promise<number> {
  if (assignments.length === 0) return 0
  const stamp = nowIso()
  await db.transaction('rw', db.supports, async () => {
    for (const assignment of assignments) {
      await db.supports.update(assignment.id, {
        scheduledQuarter: assignment.quarter,
        updatedAt: stamp,
      })
    }
  })
  return assignments.length
}

/* --------------------------- 周期标准与设置（保护科） --------------------------- */

export async function listCycleStandards(): Promise<CycleStandard[]> {
  const rows = await db.cycleStandards.toArray()
  const order: CycleTier[] = ['一级', '二级', '三级']
  return rows.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
}

/** 更新某一档位的检查周期（月）；不影响已查完件，只作用于后续重算与排期 */
export async function updateCycleStandard(tier: CycleTier, checkCycleMon: number): Promise<void> {
  const existing = await db.cycleStandards.get(tier)
  const stamp = nowIso()
  await db.cycleStandards.put({
    id: tier,
    checkCycleMon,
    createdAt: existing?.createdAt ?? stamp,
    updatedAt: stamp,
    revision: ROW_REVISION,
  })
}

export async function getSetting(): Promise<AppSetting> {
  await ensureBaseline()
  const setting = await db.settings.get(SETTING_ID)
  return (
    setting ?? {
      id: SETTING_ID,
      quarterCapacity: DEFAULT_QUARTER_CAPACITY,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      revision: ROW_REVISION,
    }
  )
}

export async function updateQuarterCapacity(quarterCapacity: number): Promise<void> {
  const existing = await getSetting()
  await db.settings.put({
    ...existing,
    quarterCapacity: Math.max(0, Math.floor(quarterCapacity)),
    updatedAt: nowIso(),
    revision: ROW_REVISION,
  })
}

/* --------------------------- 巡检批次（巡检班上报 / 保护科对账） --------------------------- */

export async function listBatches(): Promise<InspectionBatch[]> {
  const rows = await db.inspectionBatches.toArray()
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function getBatch(id: string): Promise<InspectionBatch | undefined> {
  return db.inspectionBatches.get(id)
}

export async function putBatch(row: InspectionBatch): Promise<void> {
  await db.inspectionBatches.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

export async function removeBatch(id: string): Promise<void> {
  await db.inspectionBatches.delete(id)
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
  inspectionBatches: InspectionBatch[]
  settings: AppSetting[]
}

/** 导出整库快照 */
export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [trees, surveys, measures, supports, reviews, cycleStandards, inspectionBatches, settings] =
    await Promise.all([
      db.trees.toArray(),
      db.surveys.toArray(),
      db.measures.toArray(),
      db.supports.toArray(),
      db.reviews.toArray(),
      db.cycleStandards.toArray(),
      db.inspectionBatches.toArray(),
      db.settings.toArray(),
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
    inspectionBatches,
    settings,
  }
}

/** 用快照覆盖整库（导入存档）；周期标准 / 设置缺省时按现档兜底 */
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
      db.inspectionBatches,
      db.settings,
    ],
    async () => {
      await Promise.all([
        db.trees.clear(),
        db.surveys.clear(),
        db.measures.clear(),
        db.supports.clear(),
        db.reviews.clear(),
        db.cycleStandards.clear(),
        db.inspectionBatches.clear(),
        db.settings.clear(),
      ])
      await db.trees.bulkPut(snapshot.trees.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.surveys.bulkPut(snapshot.surveys.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.measures.bulkPut(snapshot.measures.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.supports.bulkPut(
        snapshot.supports.map((row) => ({
          ...{ scheduledQuarter: '', reconciledAt: '' },
          ...row,
          revision: ROW_REVISION,
        }))
      )
      await db.reviews.bulkPut(snapshot.reviews.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.cycleStandards.bulkPut(
        (snapshot.cycleStandards ?? []).map((row) => ({ ...row, revision: ROW_REVISION }))
      )
      await db.inspectionBatches.bulkPut(
        (snapshot.inspectionBatches ?? []).map((row) => ({ ...row, revision: ROW_REVISION }))
      )
      await db.settings.bulkPut((snapshot.settings ?? []).map((row) => ({ ...row, revision: ROW_REVISION })))
    }
  )
  // 旧档可能不含周期标准 / 容量：按现有档案回填，保证升级后可用
  await ensureBaseline()
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
      db.inspectionBatches,
      db.settings,
    ],
    async () => {
      await Promise.all([
        db.trees.clear(),
        db.surveys.clear(),
        db.measures.clear(),
        db.supports.clear(),
        db.reviews.clear(),
        db.cycleStandards.clear(),
        db.inspectionBatches.clear(),
        db.settings.clear(),
      ])
    }
  )
  await seedDatabase()
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [trees, surveys, measures, supports, reviews, cycleStandards, inspectionBatches, settings] =
    await Promise.all([
      db.trees.count(),
      db.surveys.count(),
      db.measures.count(),
      db.supports.count(),
      db.reviews.count(),
      db.cycleStandards.count(),
      db.inspectionBatches.count(),
      db.settings.count(),
    ])
  return { trees, surveys, measures, supports, reviews, cycleStandards, inspectionBatches, settings }
}
