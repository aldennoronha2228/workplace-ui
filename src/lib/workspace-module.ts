let workspaceModule: Promise<typeof import('@/components/hardware-workspace')> | undefined

export function loadWorkspaceModule() {
  workspaceModule ??= import('@/components/hardware-workspace').catch(error => {
    workspaceModule = undefined
    throw error
  })
  return workspaceModule
}
