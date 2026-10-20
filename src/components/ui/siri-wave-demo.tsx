"use client"

import { SiriWave } from "@/components/ui/siri-wave"

export function SiriWaveDemo() {
  return (
    <div className="flex min-h-[420px] items-center justify-center bg-black">
      <SiriWave variant="wave" size={420} renderScale={0.75} className="max-w-full" />
    </div>
  )
}

export default SiriWaveDemo
