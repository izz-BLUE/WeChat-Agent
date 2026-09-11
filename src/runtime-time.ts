export interface RuntimeClock {
  now(): Date
}

export interface RuntimeTimeFacts {
  utcIso: string
  localDate: string
  localDateTime: string
  timeZone: string
}

const SYSTEM_RUNTIME_CLOCK: RuntimeClock = {
  now: () => new Date(),
}

function validTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0))
    return true
  } catch {
    return false
  }
}

export function validateRuntimeTimeZone(configured: string | undefined): void {
  if (configured !== undefined && configured.trim().length > 0 && !validTimeZone(configured.trim())) {
    throw new Error(`AGENT_TIME_ZONE is invalid: ${configured}`)
  }
}

export function resolveRuntimeTimeZone(configured?: string): string {
  const selected = configured?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone
  const timeZone = selected || 'UTC'
  validateRuntimeTimeZone(timeZone)
  return timeZone
}

function dateParts(date: Date, timeZone: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]))
}

export function createRuntimeTimeFacts(
  clock: RuntimeClock = SYSTEM_RUNTIME_CLOCK,
  configuredTimeZone?: string,
): RuntimeTimeFacts {
  const now = clock.now()
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error('Runtime clock returned an invalid date')
  }
  const timeZone = resolveRuntimeTimeZone(configuredTimeZone)
  const parts = dateParts(now, timeZone)
  const localDate = `${parts.year}-${parts.month}-${parts.day}`
  return {
    utcIso: now.toISOString(),
    localDate,
    localDateTime: `${localDate}T${parts.hour}:${parts.minute}:${parts.second}`,
    timeZone,
  }
}

export function formatRuntimeTimeFacts(facts: RuntimeTimeFacts): string {
  return [
    `CURRENT_TIME_UTC=${facts.utcIso}`,
    `CURRENT_LOCAL_DATE=${facts.localDate}`,
    `CURRENT_LOCAL_DATETIME=${facts.localDateTime}`,
    `CURRENT_TIME_ZONE=${facts.timeZone}`,
  ].join('\n')
}
