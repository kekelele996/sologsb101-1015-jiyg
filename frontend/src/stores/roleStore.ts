/**
 * 操作角色（Role）
 * 两侧职责分开：
 * - 巡检班：只记树体检查记录（编组批次、交回、被退回后改记录重报）；
 * - 保护科：管加固件台账、周期标准、季度容量、长势复评结论，并负责批次核对 / 整批退回 / 对账。
 * 纯前端应用无登录体系，角色仅为本地界面开关，保存在 localStorage。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'

export type Role = '巡检班' | '保护科'

export const ROLE_OPTIONS: Role[] = ['巡检班', '保护科']

const ROLE_KEY = 'gbheritagetree:role'

function readRole(): Role {
  try {
    const raw = window.localStorage.getItem(ROLE_KEY)
    return raw === '保护科' ? '保护科' : '巡检班'
  } catch {
    return '巡检班'
  }
}

export const useRoleStore = defineStore('role', () => {
  const role = ref<Role>(readRole())

  const isPatrol = () => role.value === '巡检班'
  const isProtection = () => role.value === '保护科'

  function setRole(next: Role): void {
    role.value = next
    try {
      window.localStorage.setItem(ROLE_KEY, next)
    } catch {
      /* 隐私模式写入失败时静默降级 */
    }
  }

  return { role, isPatrol, isProtection, setRole }
})
