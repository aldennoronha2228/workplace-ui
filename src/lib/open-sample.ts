export async function openSample(id: string) {
  const response = await fetch(`/api/hardware/samples/${encodeURIComponent(id)}/open`, { method: 'POST' })
  const project = await response.json()
  if (!response.ok) throw new Error(typeof project.detail === 'string' ? project.detail : 'Could not open this sample.')
  if (project.setup_guidance) {
    try {
      localStorage.setItem(`wireup.project.${project.id}.chats.v1`, JSON.stringify([{
        id: crypto.randomUUID(), title: 'Getting started', updatedAt: Date.now(), messages: [{
          id: crypto.randomUUID(), role: 'assistant', content: project.setup_guidance, status: 'done',
        }],
      }]))
    } catch { /* Route state preserves guidance when browser storage is unavailable. */ }
  }
  return project
}
