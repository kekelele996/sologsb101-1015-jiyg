/**
 * 演示数据播种（幂等）
 * 父 → 子 → 孙三层链路：古树 → 树体检查 / 复壮措施 / 加固件 / 长势复评
 * v3 起补齐：周期标准、季度容量、检查批次（已对账 / 已交回 / 已退回 / 草稿）、待检计划。
 * 所有 id 固定，保证 /trees/:id/surveys 深链一定命中真实数据。
 */
import { db, ROW_REVISION, type AppSetting } from './db'
import type { Tree } from '../types/tree'
import type { Survey } from '../types/survey'
import type { Measure } from '../types/measure'
import type { Support } from '../types/support'
import type { Review } from '../types/review'
import type { CycleStandard } from '../types/cycle'
import { DEFAULT_CYCLE_STANDARDS, DEFAULT_QUARTER_CAPACITY, SETTING_QUARTER_CAPACITY } from '../types/cycle'
import type { SurveyBatch } from '../types/batch'
import type { SupportCheckPlan } from '../types/plan'
import { cycleMonthsOf, packByQuarterCapacity, quarterOf, supportDueDate } from './cycle'

const SEED_TIME = '2026-01-08T01:30:00.000Z'

/** 固定 id，便于文档与深链验证 */
export const SEED_IDS = {
  treeA: 'tree-guozijian-0007',
  treeB: 'tree-xiangshan-0113',
  treeC: 'tree-ritan-0246',
} as const

type Row<T> = Omit<T, 'createdAt' | 'updatedAt' | 'revision'>

function wrap<T>(row: Row<T>): T {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION } as T
}

/**
 * 播种演示数据。调用方（initDatabase）已保证仅在主表为空时调用；
 * 这里再做一次防御：若已存在古树档案则直接返回。
 */
export async function seedDatabase(): Promise<void> {
  const exists = await db.trees.count()
  if (exists > 0) return

  // ---------------- 古树档案（3 棵，覆盖保护级别） ----------------
  const trees: Tree[] = [
    wrap<Tree>({
      id: SEED_IDS.treeA,
      code: '京-01-0007',
      species: '国槐',
      protectLevel: '一级',
      ageYears: 320,
      location: '东城区国子监街 18 号院门前',
      owner: '东城区园林绿化局',
      lastMeasureDate: '2025-09-12',
    }),
    wrap<Tree>({
      id: SEED_IDS.treeB,
      code: '京-02-0113',
      species: '银杏',
      protectLevel: '一级',
      ageYears: 260,
      location: '海淀区香山南路甲 3 号院',
      owner: '海淀区园林绿化服务中心',
      lastMeasureDate: '2026-03-28',
    }),
    wrap<Tree>({
      id: SEED_IDS.treeC,
      code: '京-05-0246',
      species: '侧柏',
      protectLevel: '二级',
      ageYears: 150,
      location: '朝阳区日坛公园北门内',
      owner: '朝阳区公园管理中心',
      lastMeasureDate: '2026-04-11',
    }),
  ]

  // ---------------- 树体检查（批次归属与级别快照） ----------------
  // batch-1 已对账（b3）；batch-2 已交回（c3，带回旧级别「三级」与现档「二级」不符，供对账演示）；
  // batch-3 已退回（c1）；其余记录未交回，可在编批次中继续上报。
  const surveys: Survey[] = [
    wrap<Survey>({ id: 'survey-a1', treeId: SEED_IDS.treeA, date: '2023-05-18', heightM: 14.4, dbhCm: 97.5, crownM: 13.8, leanDeg: 3.6, hollowCount: 2, siteNote: '铺装', protectLevelSnapshot: '', batchId: '' }),
    wrap<Survey>({ id: 'survey-a2', treeId: SEED_IDS.treeA, date: '2024-06-02', heightM: 14.6, dbhCm: 99, crownM: 14.1, leanDeg: 4.1, hollowCount: 2, siteNote: '铺装', protectLevelSnapshot: '', batchId: '' }),
    wrap<Survey>({ id: 'survey-a3', treeId: SEED_IDS.treeA, date: '2026-05-08', heightM: 14.8, dbhCm: 100.2, crownM: 14.4, leanDeg: 4.4, hollowCount: 3, siteNote: '铺装', protectLevelSnapshot: '', batchId: '' }),
    wrap<Survey>({ id: 'survey-b1', treeId: SEED_IDS.treeB, date: '2024-07-18', heightM: 18.2, dbhCm: 118.4, crownM: 16.2, leanDeg: 1.8, hollowCount: 0, siteNote: '裸土', protectLevelSnapshot: '', batchId: '' }),
    wrap<Survey>({ id: 'survey-b2', treeId: SEED_IDS.treeB, date: '2025-08-02', heightM: 18.5, dbhCm: 120.1, crownM: 16.6, leanDeg: 2.1, hollowCount: 0, siteNote: '裸土', protectLevelSnapshot: '', batchId: '' }),
    wrap<Survey>({ id: 'survey-b3', treeId: SEED_IDS.treeB, date: '2026-07-15', heightM: 18.7, dbhCm: 121.3, crownM: 16.9, leanDeg: 2.3, hollowCount: 1, siteNote: '裸土', protectLevelSnapshot: '一级', batchId: 'batch-1' }),
    wrap<Survey>({ id: 'survey-c1', treeId: SEED_IDS.treeC, date: '2024-08-15', heightM: 9.6, dbhCm: 62.5, crownM: 7.4, leanDeg: 11.2, hollowCount: 4, siteNote: '积水', protectLevelSnapshot: '二级', batchId: 'batch-3' }),
    wrap<Survey>({ id: 'survey-c2', treeId: SEED_IDS.treeC, date: '2025-08-20', heightM: 9.7, dbhCm: 63.1, crownM: 7.1, leanDeg: 12.4, hollowCount: 4, siteNote: '积水', protectLevelSnapshot: '', batchId: '' }),
    wrap<Survey>({ id: 'survey-c3', treeId: SEED_IDS.treeC, date: '2026-07-20', heightM: 9.7, dbhCm: 63.4, crownM: 6.9, leanDeg: 12.8, hollowCount: 5, siteNote: '铺装', protectLevelSnapshot: '三级', batchId: 'batch-2' }),
  ]

  // ---------------- 复壮措施（每棵 2–3 条，覆盖三种状态） ----------------
  const measures: Measure[] = [
    wrap<Measure>({ id: 'measure-a1', treeId: SEED_IDS.treeA, type: '换土', date: '2024-04-10', material: '基质土 6 m³ + 草炭土 2 m³', operator: '王建军', state: '已完成' }),
    wrap<Measure>({ id: 'measure-a2', treeId: SEED_IDS.treeA, type: '树洞修补', date: '2025-09-12', material: '防腐树脂 + 木栓填充', operator: '李慧', state: '已完成' }),
    wrap<Measure>({ id: 'measure-a3', treeId: SEED_IDS.treeA, type: '透气', date: '2026-03-20', material: '透气砖 12 块 + 通气管 4 根', operator: '张勇', state: '实施中' }),
    wrap<Measure>({ id: 'measure-b1', treeId: SEED_IDS.treeB, type: '换土', date: '2024-04-15', material: '腐叶土 5 m³ + 河沙 1 m³', operator: '赵鹏', state: '已完成' }),
    wrap<Measure>({ id: 'measure-b2', treeId: SEED_IDS.treeB, type: '施肥', date: '2026-03-28', material: '有机肥 80 kg + 复合肥 15 kg', operator: '赵鹏', state: '已完成' }),
    wrap<Measure>({ id: 'measure-b3', treeId: SEED_IDS.treeB, type: '透气', date: '2026-06-10', material: '通气管 6 根', operator: '孙晓', state: '计划' }),
    wrap<Measure>({ id: 'measure-c1', treeId: SEED_IDS.treeC, type: '树洞修补', date: '2026-04-11', material: '不锈钢网 + 防腐树脂', operator: '周敏', state: '已完成' }),
    wrap<Measure>({ id: 'measure-c2', treeId: SEED_IDS.treeC, type: '病虫害防治', date: '2026-05-06', material: '生物制剂 2 次施药', operator: '周敏', state: '计划' }),
  ]

  // ---------------- 加固件（周期档位取古树现档级别；最近检查仅对账回写） ----------------
  // treeB 拉纤已在 batch-1 对账，最近检查 2026-07-15；treeA 支撑杆 / treeC 避雷仍超期。
  const supports: Support[] = [
    wrap<Support>({ id: 'support-a1', treeId: SEED_IDS.treeA, type: '支撑杆', installDate: '2019-04-08', cycleLevel: '一级', lastCheckDate: '2024-03-15' }),
    wrap<Support>({ id: 'support-a2', treeId: SEED_IDS.treeA, type: '避雷', installDate: '2020-07-01', cycleLevel: '一级', lastCheckDate: '2025-06-01' }),
    wrap<Support>({ id: 'support-b1', treeId: SEED_IDS.treeB, type: '拉纤', installDate: '2021-09-20', cycleLevel: '一级', lastCheckDate: '2026-07-15' }),
    wrap<Support>({ id: 'support-c1', treeId: SEED_IDS.treeC, type: '避雷', installDate: '2018-06-01', cycleLevel: '二级', lastCheckDate: '2025-05-20' }),
    wrap<Support>({ id: 'support-c2', treeId: SEED_IDS.treeC, type: '支撑杆', installDate: '2022-05-10', cycleLevel: '二级', lastCheckDate: '2026-05-08' }),
  ]

  // ---------------- 长势复评（衰弱 / 濒危样本均带后续措施） ----------------
  const reviews: Review[] = [
    wrap<Review>({ id: 'review-a1', treeId: SEED_IDS.treeA, date: '2024-06-20', vigor: '一般', trend: '下降', conclusion: '树冠外围枝条略有回枯，整体长势中等偏下。', followUp: '' }),
    wrap<Review>({ id: 'review-a2', treeId: SEED_IDS.treeA, date: '2026-06-18', vigor: '一般', trend: '好转', conclusion: '树洞修补后新梢抽发正常，冠幅稳定。', followUp: '' }),
    wrap<Review>({ id: 'review-b1', treeId: SEED_IDS.treeB, date: '2024-07-25', vigor: '旺盛', trend: '持平', conclusion: '叶片浓绿，年生长量处于正常区间。', followUp: '' }),
    wrap<Review>({ id: 'review-b2', treeId: SEED_IDS.treeB, date: '2026-07-22', vigor: '一般', trend: '下降', conclusion: '新增空洞 1 处，树势较上次略有回落。', followUp: '2026 年秋季安排树洞修补与树盘透气改造，并加强根区水分管理。' }),
    wrap<Review>({ id: 'review-c1', treeId: SEED_IDS.treeC, date: '2024-08-28', vigor: '衰弱', trend: '下降', conclusion: '树冠稀疏，倾斜度超过 10 度，立地长期积水。', followUp: '设置拉纤加固并开挖排水盲沟，同时安排树洞修补。' }),
    wrap<Review>({ id: 'review-c2', treeId: SEED_IDS.treeC, date: '2025-09-05', vigor: '濒危', trend: '下降', conclusion: '主枝皮层开裂，根系呼吸受阻，长势濒危。', followUp: '列入重点抢救名单，实施换土、透气与病虫害综合防治，必要时设置支撑杆。' }),
    wrap<Review>({ id: 'review-c3', treeId: SEED_IDS.treeC, date: '2026-07-20', vigor: '衰弱', trend: '好转', conclusion: '排水改造后积水缓解，新梢萌发量回升。', followUp: '继续按季度监测倾斜度与空洞变化，年度复壮计划中保留透气措施。' }),
  ]

  // ---------------- 周期标准（保护科按保护级别定） ----------------
  const standards: CycleStandard[] = (['一级', '二级', '三级'] as const).map((level) =>
    wrap<CycleStandard>({ id: level, checkCycleMon: DEFAULT_CYCLE_STANDARDS[level] }),
  )

  // ---------------- 季度容量 ----------------
  const settings: AppSetting[] = [
    { id: SETTING_QUARTER_CAPACITY, value: DEFAULT_QUARTER_CAPACITY, updatedAt: SEED_TIME },
  ]

  // ---------------- 检查批次（四种状态各一） ----------------
  const batches: SurveyBatch[] = [
    wrap<SurveyBatch>({
      id: 'batch-1',
      name: '2026 年三季度香山片区巡检',
      visitDate: '2026-07-15',
      plannedCount: 1,
      surveyIds: ['survey-b3'],
      status: '已对账',
      levelSnapshot: { [SEED_IDS.treeB]: '一级' },
      returnReason: '',
      submittedAt: '2026-07-16T02:00:00.000Z',
      reconciledAt: '2026-07-17T02:00:00.000Z',
    }),
    wrap<SurveyBatch>({
      id: 'batch-2',
      name: '2026 年三季度日坛公园巡检',
      visitDate: '2026-07-20',
      plannedCount: 1,
      surveyIds: ['survey-c3'],
      status: '已交回',
      // 巡检带回的旧级别为三级，古树现档已由保护科调整为二级 —— 对账以现档为准
      levelSnapshot: { [SEED_IDS.treeC]: '三级' },
      returnReason: '',
      submittedAt: '2026-07-21T02:00:00.000Z',
      reconciledAt: '',
    }),
    wrap<SurveyBatch>({
      id: 'batch-3',
      name: '2024 年三季度日坛公园巡检',
      visitDate: '2024-08-15',
      plannedCount: 1,
      surveyIds: ['survey-c1'],
      status: '已退回',
      levelSnapshot: { [SEED_IDS.treeC]: '二级' },
      returnReason: '胸径数值与现场复核不符（62.5cm 疑误填），整批退回核实后重报。',
      submittedAt: '2024-08-16T02:00:00.000Z',
      reconciledAt: '',
    }),
    wrap<SurveyBatch>({
      id: 'batch-4',
      name: '2026 年四季度国子监片区巡检（在编）',
      visitDate: '2026-10-02',
      plannedCount: 1,
      surveyIds: [],
      status: '草稿',
      levelSnapshot: {},
      returnReason: '',
      submittedAt: '',
      reconciledAt: '',
    }),
  ]

  // ---------------- 待检计划：按周期标准 + 季度容量装箱 ----------------
  const levelOfTree = new Map(trees.map((tree) => [tree.id, tree.protectLevel]))
  const packInput = supports.map((support) => {
    const level = levelOfTree.get(support.treeId) ?? support.cycleLevel
    const months = cycleMonthsOf(level, standards)
    return {
      supportId: support.id,
      treeId: support.treeId,
      dueDate: supportDueDate(support, months),
      cycleLevel: level,
      checkCycleMon: months,
    }
  })
  const packed = packByQuarterCapacity(packInput, DEFAULT_QUARTER_CAPACITY, quarterOf('2026-10-04'))
  const plans: SupportCheckPlan[] = packed.map((item) =>
    wrap<SupportCheckPlan>({
      id: `plan-${item.supportId}`,
      supportId: item.supportId,
      treeId: item.treeId,
      quarter: item.quarter,
      dueDate: item.dueDate,
      cycleLevel: item.cycleLevel,
      checkCycleMon: item.checkCycleMon,
      status: '待检',
      checkedDate: '',
      sourceBatchId: '',
    }),
  )
  // batch-1 对账时完成检查的历史计划（已查冻结，后续重排不再改动）
  plans.push(
    wrap<SupportCheckPlan>({
      id: 'plan-support-b1-done',
      supportId: 'support-b1',
      treeId: SEED_IDS.treeB,
      quarter: '2026Q3',
      dueDate: '2026-07-15',
      cycleLevel: '一级',
      checkCycleMon: DEFAULT_CYCLE_STANDARDS.一级,
      status: '已查',
      checkedDate: '2026-07-15',
      sourceBatchId: 'batch-1',
    }),
  )

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
      await db.trees.bulkPut(trees)
      await db.surveys.bulkPut(surveys)
      await db.measures.bulkPut(measures)
      await db.supports.bulkPut(supports)
      await db.reviews.bulkPut(reviews)
      await db.cycleStandards.bulkPut(standards)
      await db.appSettings.bulkPut(settings)
      await db.surveyBatches.bulkPut(batches)
      await db.supportCheckPlans.bulkPut(plans)
    },
  )
}
