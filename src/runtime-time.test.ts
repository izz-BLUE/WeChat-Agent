import { strict as assert } from 'node:assert'
import { createRuntimeTimeFacts, formatRuntimeTimeFacts, validateRuntimeTimeZone } from './runtime-time.js'

let cases = 0
let failures = 0

function check(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

async function test(name: string, body: () => void | Promise<void>): Promise<void> {
  cases += 1
  try {
    await body()
    console.log(`[RUNTIME_TIME_CASE] name=${name} result=PASS`)
  } catch (error) {
    failures += 1
    console.log(`[RUNTIME_TIME_CASE] name=${name} result=FAIL detail=${error instanceof Error ? error.message : String(error)}`)
  }
}

const FIXED_UTC = new Date('2026-09-11T07:40:00.000Z')

async function main(): Promise<void> {
  await test('fixed clock renders UTC and local Asia Shanghai facts', () => {
    const facts = createRuntimeTimeFacts({ now: () => FIXED_UTC }, 'Asia/Shanghai')
    assert.deepEqual(facts, {
      utcIso: '2026-09-11T07:40:00.000Z',
      localDate: '2026-09-11',
      localDateTime: '2026-09-11T15:40:00',
      timeZone: 'Asia/Shanghai',
    })
  })

  await test('formatted runtime facts expose only trusted time fields', () => {
    const facts = createRuntimeTimeFacts({ now: () => FIXED_UTC }, 'Asia/Shanghai')
    const formatted = formatRuntimeTimeFacts(facts)
    check(formatted.includes('CURRENT_TIME_UTC=2026-09-11T07:40:00.000Z'), 'UTC fact missing')
    check(formatted.includes('CURRENT_LOCAL_DATE=2026-09-11'), 'local date fact missing')
    check(formatted.includes('CURRENT_LOCAL_DATETIME=2026-09-11T15:40:00'), 'local datetime fact missing')
    check(formatted.includes('CURRENT_TIME_ZONE=Asia/Shanghai'), 'timezone fact missing')
    check(!/requester|sender|conversation|wxid|signature|owner|identity|id/iu.test(formatted), 'runtime facts contain identity fields')
  })

  await test('invalid configured timezone fails validation', () => {
    assert.throws(() => validateRuntimeTimeZone('Not/A/Timezone'), /AGENT_TIME_ZONE/)
    validateRuntimeTimeZone('Asia/Shanghai')
  })

  console.log(`[RUNTIME_TIME_TEST_SUMMARY] cases=${cases} failures=${failures}`)
  if (failures > 0) {
    process.exitCode = 1
  }
}

await main()
