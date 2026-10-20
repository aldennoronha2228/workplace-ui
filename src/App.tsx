import { HardwareWorkspace } from './components/hardware-workspace'
import './components/hardware-workspace.css'
import { useState } from 'react'

function StaticChatPanel() {
  const [draft, setDraft] = useState('')
  const [messages, setMessages] = useState<string[]>(['hi'])

  const send = () => {
    const text = draft.trim()
    if (!text) return
    setMessages(previous => [...previous, text])
    setDraft('')
  }

  const reset = () => {
    setMessages([])
    setDraft('')
  }

  return (
    <div className="static-chat">
      <header className="static-chat-header">
        <span>Getting started</span>
        <button type="button" onClick={reset}>＋ New chat</button>
      </header>
      <div className="static-chat-body">
        <p>Guide is generated from the sample template, not a live model response or proof of a successful simulation.</p>
        <p><strong>Required libraries:</strong> Adafruit SSD1306, Adafruit GFX Library. Install these before compiling the unchanged source; dependencies are not automatically installed or verified.</p>
        <p><strong>Simulation scope:</strong> All listed parts have models for the selected board; compile and run the actual firmware to verify behavior.</p>
        <button className="static-copy" type="button">▣ Copy</button>
        {messages.map((message, index) => (
          <div key={`${message}-${index}`}>
            <div className="static-user-message">{message}</div>
            <div className="static-assistant-label"><span className="chat-mark">W</span> WireUp <small>claude-sonnet-5</small></div>
            <div className="static-error">
              <strong>ZenLLM authorization failed. Check API key permissions and model access.</strong>
              <span>Failed</span>
              <code>model_error</code>
              <p>ZenLLM authorization failed. Check API key permissions and model access.</p>
              <small>0 tool calls · 1 model call · 4.9s</small>
              <hr />
              <span>› Saved changes reported by backend</span>
            </div>
            <button className="static-retry" type="button" onClick={() => setDraft(message)}>↻ Retry</button>
          </div>
        ))}
      </div>
      <footer className="static-chat-composer">
        <input
          value={draft}
          placeholder="Ask about your project..."
          aria-label="Ask about your project"
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              send()
            }
          }}
        />
        <div><span>claude-sonnet-5</span><small>$1.00 / $5.00</small><button type="button" aria-label="Send message" onClick={send}>↑</button></div>
      </footer>
    </div>
  )
}

export default function App() {
  return <HardwareWorkspace chatSlot={<StaticChatPanel />} />
}
