/**
 * 季度（批次）工具
 * 加固件检查按季度分批、容量有限；本模块统一季度的解析、比较与推进，
 * 供「待检清单排期」与「检查批次上报 / 对账」消费。
 */

/** YYYY-MM-DD → YYYYQn */
export function quarterOfDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(date)
  if (!match) return ''
  const month = Number(match[2])
  return `${match[1]}Q${Math.floor((month - 1) / 3) + 1}`
}

/** 由 YYYYQn 取年份 */
export function quarterYear(quarter: string): number {
  return Number(quarter.slice(0, 4)) || 0
}

/** 由 YYYYQn 取季度序号 1–4 */
export function quarterIndex(quarter: string): number {
  return Number(quarter.slice(5, 6)) || 0
}

/** 季度可比较序号（2026Q4 → 2026*4+4=8044… 用连续序号即可） */
export function quarterOrder(quarter: string): number {
  const q = quarterIndex(quarter)
  if (q < 1 || q > 4) return Number.NEGATIVE_INFINITY
  return quarterYear(quarter) * 4 + q
}

/** 当前季度 */
export function currentQuarter(reference = new Date()): string {
  const year = reference.getFullYear()
  const q = Math.floor(reference.getMonth() / 3) + 1
  return `${year}Q${q}`
}

/** 推进 n 个季度，n 可为负 */
export function shiftQuarter(quarter: string, n: number): string {
  const order = quarterOrder(quarter)
  if (order === Number.NEGATIVE_INFINITY) return ''
  const next = order + n
  const year = Math.floor((next - 1) / 4)
  const q = ((next - 1) % 4) + 1
  return `${year}Q${q}`
}

/** 季度起始日期 YYYY-MM-DD */
export function quarterStart(quarter: string): string {
  const q = quarterIndex(quarter)
  if (q < 1 || q > 4) return ''
  return `${quarterYear(quarter)}-${String((q - 1) * 3 + 1).padStart(2, '0')}-01`
}

/** 季度结束日期 YYYY-MM-DD */
export function quarterEnd(quarter: string): string {
  const q = quarterIndex(quarter)
  if (q < 1 || q > 4) return ''
  const endMonthDay: Array<[string, string]> = [
    ['03', '31'],
    ['06', '30'],
    ['09', '30'],
    ['12', '31'],
  ]
  const [month, day] = endMonthDay[q - 1]
  return `${quarterYear(quarter)}-${month}-${day}`
}

/** 两个季度相差的季度数（b - a） */
export function quartersBetween(a: string, b: string): number {
  return quarterOrder(b) - quarterOrder(a)
}

/** YYYYQn → 中文「2026 年第 4 季度」 */
export function quarterLabel(quarter: string): string {
  const q = quarterIndex(quarter)
  if (q < 1 || q > 4) return quarter
  return `${quarterYear(quarter)} 年第 ${q} 季度`
}

/** 可选批次季度列表：从当前季度往前 2 个、往后 4 个 */
export function quarterOptions(reference = new Date()): string[] {
  const base = currentQuarter(reference)
  return [-2, -1, 0, 1, 2, 3, 4].map((offset) => shiftQuarter(base, offset))
}
