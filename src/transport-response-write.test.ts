import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { randomUUID } from 'node:crypto'
import type { AgentExecutor } from './agent-adapter.js'
import { ProductionAgentTransportServer } from './production-agent-transport.js'

async function run(): Promise<void> {
  const pipeName = `response-write-${randomUUID()}`
  const logs: string[] = []
  const originalLog = console.log
  const originalError = console.error
  console.log = (message?: unknown) => logs.push(String(message ?? ''))
  console.error = (message?: unknown) => logs.push(String(message ?? ''))

  const agent: AgentExecutor = {
    async complete() {
      await new Promise((resolve) => setTimeout(resolve, 50))
      return '延迟回复'
    },
  }
  const transport = new ProductionAgentTransportServer({ pipeName, agent })
  try {
    await transport.start()
    const socket = connect('\\\\.\\pipe\\' + pipeName)
    socket.on('error', () => undefined)
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => {
        socket.write(`${JSON.stringify({
          kind: 'INBOUND_MESSAGE',
          message: {
            msgId: 'write-fail-1',
            type: 1,
            timestamp: Date.now(),
            from: 'response-write-room@chatroom',
            wxid: 'response-write-wxid',
            content: '@椰椰 你好',
            signature: 'response-write-sender',
            isMentioned: true,
            conversationType: 'GROUP',
            conversationId: 'response-write-room@chatroom',
            senderId: 'response-write-sender',
            requesterId: 'response-write-sender',
            requesterSource: 'TEST',
            requesterRole: 'MEMBER',
            ownerConfigured: false,
            publicDisplayName: '测试成员',
            userContentSpan: { start: 0, length: 8 },
          },
        })}\n`, 'utf8', () => {
          socket.destroy()
          resolve()
        })
      })
      socket.once('error', reject)
    })

    await new Promise((resolve) => setTimeout(resolve, 150))
    assert(
      logs.some((line) => line.includes('[TRANSPORT_RESPONSE_WRITE] result=FAIL reason=SOCKET_ENDED')),
      `missing structured ended-socket diagnostic: ${logs.join(' | ')}`,
    )
  } finally {
    await transport.stop()
    console.log = originalLog
    console.error = originalError
  }
}

await run()
console.log('[TRANSPORT_RESPONSE_WRITE_CASE] ended socket is classified without retry result=PASS')
