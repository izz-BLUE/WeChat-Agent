/** Presentation-only metadata sanitizer. It has no authority or identity semantics. */
export const MAX_PUBLIC_DISPLAY_NAME_SCALARS = 64

export function sanitizePublicDisplayName(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null
  }

  const output: string[] = []
  let pendingSpace = false
  for (const scalar of value) {
    if (scalar === '\r' || scalar === '\n' || scalar === '\t') {
      pendingSpace = output.length > 0
      continue
    }
    if (/\p{Cc}/u.test(scalar)) {
      continue
    }
    if (/\s/u.test(scalar)) {
      pendingSpace = output.length > 0
      continue
    }
    if (pendingSpace && output.length + 1 >= MAX_PUBLIC_DISPLAY_NAME_SCALARS) {
      break
    }
    if (pendingSpace) {
      output.push(' ')
      pendingSpace = false
    }
    if (output.length >= MAX_PUBLIC_DISPLAY_NAME_SCALARS) {
      break
    }
    output.push(scalar)
  }

  const normalized = output.join('').trim()
  return normalized.length > 0 ? normalized : null
}
