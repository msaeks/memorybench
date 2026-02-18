import { resolve, sep } from "path"

const SAFE_ID_REGEX = /^[A-Za-z0-9_-]{1,80}$/

export function isSafeId(value: string): boolean {
  return SAFE_ID_REGEX.test(value)
}

export function assertSafeId(value: string, fieldName: string): string {
  if (!isSafeId(value)) {
    throw new Error(`Invalid ${fieldName}`)
  }
  return value
}

export function resolveSafeSubpath(basePath: string, id: string, fieldName: string): string {
  const safeId = assertSafeId(id, fieldName)
  const root = resolve(basePath)
  const target = resolve(root, safeId)

  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`Invalid ${fieldName}`)
  }

  return target
}

export function parseBoundedInt(
  value: string | null,
  fallback: number,
  min: number,
  max: number
): number | null {
  if (value === null) return fallback

  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) return null
  if (parsed < min || parsed > max) return null

  return parsed
}
