const names: Record<string, string> = { arduino: 'Arduino', uno: 'Uno', nano: 'Nano', mega: 'Mega', esp32: 'ESP32', esp8266: 'ESP8266', raspberry: 'Raspberry', pico: 'Pico', led: 'LED', lcd: 'LCD', oled: 'OLED', iot: 'IoT', dc: 'DC', rgb: 'RGB', usb: 'USB', wifi: 'Wi-Fi' }

export function projectTitle(prompt: string): string {
  let text = prompt.trim().split(/[\n.!?]/)[0]
  text = text.replace(/^(?:please\s+)?(?:i\s+(?:want|need)\s+(?:you\s+)?to\s+)?(?:build|make|create|design|generate|develop|implement)\s+(?:me\s+)?(?:an?\s+)?/i, '')
  const board = text.match(/\b(?:using|with|on)\s+(?:an?\s+)?(arduino(?:\s+(?:uno|nano|mega))?|esp32|esp8266|raspberry\s+pi(?:\s+pico)?|pi\s+pico)\b/i)
  if (board) text = `${board[1]} ${text.replace(board[0], '')}`
  text = text.replace(/\b(?:that|which)\s+.+$/i, '').replace(/\s+/g, ' ').trim()
  const words = text.split(' ').filter(Boolean).slice(0, 7)
  if (!words.length) return 'Untitled Circuit'
  return words.map(word => names[word.toLowerCase()] ?? (word.charAt(0).toUpperCase() + word.slice(1))).join(' ').slice(0, 80).trim()
}
