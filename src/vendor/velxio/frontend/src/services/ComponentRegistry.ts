export class ComponentRegistry {
  static getInstance() { return new ComponentRegistry() }
  async load() {}
  getById(_id: string) { return null }
}
