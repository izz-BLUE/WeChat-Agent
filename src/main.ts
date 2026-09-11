import { WechatyBuilder } from 'wechaty'
import { types as PuppetTypes } from 'wechaty-puppet'
import { PuppetXp } from 'wechaty-puppet-xp'
import { ChatService } from './chat.js'
import { GroupContext } from './context.js'
import { config, validateChatConfig } from './config.js'
import { createRuntimeTimeFacts } from './runtime-time.js'

if (config.botMode === 'chat') {
  validateChatConfig()
}

const context = new GroupContext(config.maxContextMessages)
const chatService = config.botMode === 'chat'
  ? new ChatService(config.openAiApiBase, config.openAiApiKey, config.openAiModel)
  : undefined

const bot = WechatyBuilder.build({
  name: 'wechat-ai-bot',
  puppet: config.puppet === 'xp' ? new PuppetXp() : undefined,
})

bot.on('start', () => console.log('[START] bot started'))

bot.on('login', (user) => {
  console.log(`[LOGIN] ${user.name()}`)
})

bot.on('logout', (user) => {
  console.log(`[LOGOUT] ${user.name()}`)
})

bot.on('message', async (message) => {
  try {
    if (message.self()) {
      return
    }

    const room = await message.room()
    if (!room) {
      return
    }

    if (message.type() !== PuppetTypes.Message.Text) {
      return
    }

    const talker = message.talker()
    const roomId = room.id
    const senderId = talker.id
    const senderName = talker.name()
    const text = message.text().trim()

    if (!text) {
      return
    }

    const groupMessage = {
      senderId,
      senderName,
      text,
      timestamp: Date.now(),
    }

    context.append(roomId, groupMessage)

    const mentioned = await message.mentionSelf()
    console.log(`[MESSAGE] room=${roomId} sender=${senderName} mentioned=${mentioned}`)

    if (!mentioned) {
      return
    }

    if (config.botMode === 'smoke') {
      await room.say('pong', talker)
      console.log(`[REPLY] room=${roomId} sender=${senderName}`)
      return
    }

    const recent = context.recent(roomId, config.contextMessageLimit, config.maxContextChars)
    console.log(`[CHAT] room=${roomId} sender=${senderName} contextMessages=${recent.length}`)

    try {
      const runtimeTime = createRuntimeTimeFacts(undefined, config.agentTimeZone)
      // Legacy wechaty dev path: it has no trusted runtime identity contract, so
      // it can never resolve an owner. The production path is the C# runtime.
      const reply = await chatService!.reply(recent, groupMessage, {
        botDisplayName: config.botDisplayName,
        mention: mentioned ? 'MENTIONED' : 'NOT_MENTIONED',
        requesterRole: 'MEMBER',
        ownerConfigured: false,
        runtimeTime,
      })
      await room.say(reply, talker)
      console.log(`[REPLY] room=${roomId} sender=${senderName}`)
    } catch (error) {
      console.error('[ERROR]', error)
      await room.say('暂时无法回复，请稍后再试。', talker)
      console.log(`[REPLY] room=${roomId} sender=${senderName}`)
    }
  } catch (error) {
    console.error('[ERROR]', error)
  }
})

bot.start().catch((error) => {
  console.error('[ERROR]', error)
  process.exitCode = 1
})
