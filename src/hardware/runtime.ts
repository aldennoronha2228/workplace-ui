export class HardwareRuntime {
  updateProject(_p: any) {}
  applyNativeState(..._args: any[]) {}
  subscribeInstrumentation(_cb: any) { return () => {} }
  clearSamples() {}
}
export type RuntimeResults = any
