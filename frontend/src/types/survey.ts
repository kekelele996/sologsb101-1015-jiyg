/**
 * 树体检查（Survey）
 * 巡检班职责：每次上门检查记录树高、胸径、冠幅、倾斜度、空洞数与立地状况。
 * 巡检记录按批次交回保护科；记录一旦进入「已交回 / 已对账」批次即锁定，巡检班不能再改。
 */

/** 立地状况：铺装 / 裸土 / 积水 */
export type SiteNote = '铺装' | '裸土' | '积水'

export const SITE_NOTE_OPTIONS: SiteNote[] = ['铺装', '裸土', '积水']

import type { ProtectLevel } from './tree'

export interface Survey {
  id: string
  /** 所属古树 */
  treeId: string
  /** 检查日期 YYYY-MM-DD */
  date: string
  /** 树高（米） */
  heightM: number
  /** 胸径（厘米） */
  dbhCm: number
  /** 冠幅（米） */
  crownM: number
  /** 倾斜度（度） */
  leanDeg: number
  /** 空洞数（个） */
  hollowCount: number
  /** 立地状况 */
  siteNote: SiteNote
  /**
   * 交回时巡检班带回的保护级别（旧级别快照）。
   * 仅作对照展示，对账一律以古树现档 protectLevel 为准。
   */
  protectLevelSnapshot: ProtectLevel | ''
  /** 所属检查批次 id；未交回（草稿状态）时为空字符串 */
  batchId: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑树体检查的表单草稿 */
export interface SurveyDraft {
  treeId: string
  date: string
  heightM: number
  dbhCm: number
  crownM: number
  leanDeg: number
  hollowCount: number
  siteNote: SiteNote
}
