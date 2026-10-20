import { useEffect, useState } from 'react'
import type { Message } from './chat'

const isAnswer = (block: NonNullable<Message['blocks']>[number]) => block.type === 'text' && block.channel !== 'thinking' && block.channel !== 'narration'

export function useTypedMessage(message: Message): Message {
  const hasAnswers = message.blocks?.some(isAnswer)
  const total = hasAnswers ? message.blocks!.reduce((sum, block) => sum + (isAnswer(block) && block.type === 'text' ? Array.from(block.text).length : 0), 0) : Array.from(message.content).length
  const [visible, setVisible] = useState(() => message.status === 'streaming' ? 0 : total)
  useEffect(() => {
    if (visible >= total) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const frame = requestAnimationFrame(() => setVisible(total))
      return () => cancelAnimationFrame(frame)
    }
    const timer = window.setInterval(() => setVisible(count => Math.min(total, count + Math.max(3, Math.ceil((total - count) / 20)))), 30)
    return () => clearInterval(timer)
  }, [total, visible])
  let remaining = visible
  const blocks = message.blocks?.map(block => {
    if (!isAnswer(block) || block.type !== 'text') return block
    const characters = Array.from(block.text)
    const text = characters.slice(0, remaining).join('')
    remaining = Math.max(0, remaining - characters.length)
    return { ...block, text }
  })
  return { ...message, blocks, content: hasAnswers ? message.content : Array.from(message.content).slice(0, visible).join('') }
}
