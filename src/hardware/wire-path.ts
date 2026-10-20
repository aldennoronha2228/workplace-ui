export type WirePoint = { x: number; y: number }

export function roundedOrthogonalPath(points: WirePoint[], radius = 12): string {
  const vertices = points.filter((point, index) => index === 0 || point.x !== points[index - 1].x || point.y !== points[index - 1].y)
  if (!vertices.length) return ''
  let path = `M ${vertices[0].x} ${vertices[0].y}`
  for (let index = 1; index < vertices.length - 1; index++) {
    const previous = vertices[index - 1]
    const corner = vertices[index]
    const next = vertices[index + 1]
    const incoming = Math.hypot(corner.x - previous.x, corner.y - previous.y)
    const outgoing = Math.hypot(next.x - corner.x, next.y - corner.y)
    const bend = Math.min(Math.max(0, radius), incoming / 2, outgoing / 2)
    const orthogonal = (previous.x === corner.x && corner.y === next.y) || (previous.y === corner.y && corner.x === next.x)
    if (!bend || !orthogonal) {
      path += ` L ${corner.x} ${corner.y}`
      continue
    }
    const entry = { x: corner.x + (previous.x - corner.x) * bend / incoming, y: corner.y + (previous.y - corner.y) * bend / incoming }
    const exit = { x: corner.x + (next.x - corner.x) * bend / outgoing, y: corner.y + (next.y - corner.y) * bend / outgoing }
    path += ` L ${entry.x} ${entry.y} Q ${corner.x} ${corner.y} ${exit.x} ${exit.y}`
  }
  const end = vertices[vertices.length - 1]
  return vertices.length > 1 ? `${path} L ${end.x} ${end.y}` : path
}

export type WireBounds = { id: string; left: number; top: number; right: number; bottom: number }
export type WirePort = WirePoint & { direction: WirePoint; component: string }
export type RoutedWire = { id: string; start: WirePort; end: WirePort }
type Segment = { start: WirePoint; end: WirePoint }

const spacing = 12
const clearance = 18

function simplify(points: WirePoint[]): WirePoint[] {
  const result: WirePoint[] = []
  for (const point of points) {
    const last = result[result.length - 1]
    if (last?.x === point.x && last.y === point.y) continue
    const before = result[result.length - 2]
    if (before && ((before.x === last.x && last.x === point.x && (last.y - before.y) * (point.y - last.y) >= 0) || (before.y === last.y && last.y === point.y && (last.x - before.x) * (point.x - last.x) >= 0))) result.pop()
    result.push(point)
  }
  return result
}

function exitPoint(port: WirePort, bounds: WireBounds[], fanout: number): WirePoint {
  const box = bounds.find(box => box.id === port.component)
  if (!box) return { x: port.x + port.direction.x * (clearance + fanout), y: port.y + port.direction.y * (clearance + fanout) }
  return {
    x: port.direction.x < 0 ? box.left - clearance - fanout : port.direction.x > 0 ? box.right + clearance + fanout : port.x,
    y: port.direction.y < 0 ? box.top - clearance - fanout : port.direction.y > 0 ? box.bottom + clearance + fanout : port.y,
  }
}

function routeBetween(start: WirePoint, end: WirePoint, bounds: WireBounds[], occupied: Segment[]): WirePoint[] {
  const boxes = bounds.map(box => ({ left: box.left - clearance, right: box.right + clearance, top: box.top - clearance, bottom: box.bottom + clearance }))
  const left = Math.min(8, start.x, end.x, ...boxes.map(box => box.left - spacing))
  const right = Math.max(992, start.x, end.x, ...boxes.map(box => box.right + spacing))
  const top = Math.min(8, start.y, end.y, ...boxes.map(box => box.top - spacing))
  const bottom = Math.max(642, start.y, end.y, ...boxes.map(box => box.bottom + spacing))
  const xs = new Set([start.x, end.x, left, right])
  const ys = new Set([start.y, end.y, top, bottom])
  for (const box of boxes) {
    xs.add(box.left); xs.add(box.right)
    ys.add(box.top); ys.add(box.bottom)
  }
  for (const segment of occupied) {
    if (segment.start.x === segment.end.x) { xs.add(segment.start.x - spacing); xs.add(segment.start.x + spacing) }
    else { ys.add(segment.start.y - spacing); ys.add(segment.start.y + spacing) }
  }
  const xValues = [...xs].filter(x => x >= left && x <= right).sort((a, b) => a - b)
  const yValues = [...ys].filter(y => y >= top && y <= bottom).sort((a, b) => a - b)
  const columns = xValues.length
  const pointAt = (node: number): WirePoint => ({ x: xValues[node % columns], y: yValues[Math.floor(node / columns)] })
  const startNode = yValues.indexOf(start.y) * columns + xValues.indexOf(start.x)
  const endNode = yValues.indexOf(end.y) * columns + xValues.indexOf(end.x)
  const queue: { state: number; cost: number; score: number }[] = []
  const push = (item: typeof queue[number]) => {
    queue.push(item)
    let index = queue.length - 1
    while (index > 0) {
      const parent = (index - 1) >> 1
      if (queue[parent].score <= item.score) break
      queue[index] = queue[parent]; index = parent
    }
    queue[index] = item
  }
  const pop = () => {
    const first = queue[0]
    const last = queue.pop()!
    if (queue.length) {
      let index = 0
      while (index * 2 + 1 < queue.length) {
        let child = index * 2 + 1
        if (child + 1 < queue.length && queue[child + 1].score < queue[child].score) child++
        if (queue[child].score >= last.score) break
        queue[index] = queue[child]; index = child
      }
      queue[index] = last
    }
    return first
  }
  const distances = new Map<number, number>()
  const previous = new Map<number, number>()
  const initial = startNode * 3
  distances.set(initial, 0)
  push({ state: initial, cost: 0, score: Math.abs(start.x - end.x) + Math.abs(start.y - end.y) })
  while (queue.length) {
    const current = pop()
    if (current.cost !== distances.get(current.state)) continue
    const node = Math.floor(current.state / 3)
    const direction = current.state % 3
    const point = pointAt(node)
    if (node === endNode) {
      const points = [point]
      let state = current.state
      while (previous.has(state)) { state = previous.get(state)!; points.push(pointAt(Math.floor(state / 3))) }
      return simplify(points.reverse())
    }
    const column = node % columns
    const row = Math.floor(node / columns)
    const neighbors = [column > 0 ? node - 1 : -1, column + 1 < columns ? node + 1 : -1, row > 0 ? node - columns : -1, row + 1 < yValues.length ? node + columns : -1]
    for (const next of neighbors) {
      if (next < 0) continue
      const target = pointAt(next)
      const horizontal = point.y === target.y
      const low = horizontal ? Math.min(point.x, target.x) : Math.min(point.y, target.y)
      const high = horizontal ? Math.max(point.x, target.x) : Math.max(point.y, target.y)
      if (boxes.some(box => horizontal
        ? point.y > box.top && point.y < box.bottom && high > box.left && low < box.right
        : point.x > box.left && point.x < box.right && high > box.top && low < box.bottom)) continue
      let penalty = 0
      for (const segment of occupied) {
        const otherHorizontal = segment.start.y === segment.end.y
        if (horizontal === otherHorizontal) {
          const separation = Math.abs(horizontal ? point.y - segment.start.y : point.x - segment.start.x)
          const overlap = Math.min(high, horizontal ? Math.max(segment.start.x, segment.end.x) : Math.max(segment.start.y, segment.end.y)) - Math.max(low, horizontal ? Math.min(segment.start.x, segment.end.x) : Math.min(segment.start.y, segment.end.y))
          if (separation < spacing && overlap > 0) penalty += overlap * (spacing - separation) / spacing * 2
        } else {
          const crossing = horizontal ? segment.start.x : segment.start.y
          const otherLow = horizontal ? Math.min(segment.start.y, segment.end.y) : Math.min(segment.start.x, segment.end.x)
          const otherHigh = horizontal ? Math.max(segment.start.y, segment.end.y) : Math.max(segment.start.x, segment.end.x)
          const constant = horizontal ? point.y : point.x
          if (crossing >= low && crossing <= high && constant > otherLow && constant < otherHigh) penalty += 20
        }
      }
      const nextDirection = horizontal ? 1 : 2
      const cost = current.cost + high - low + penalty + (direction && direction !== nextDirection ? 48 : 0)
      const state = next * 3 + nextDirection
      if (cost >= (distances.get(state) ?? Infinity)) continue
      distances.set(state, cost); previous.set(state, current.state)
      push({ state, cost, score: cost + Math.abs(target.x - end.x) + Math.abs(target.y - end.y) })
    }
  }
  // Overlapping component bounds can leave no unobstructed exit.
  return simplify([start, { x: start.x, y: end.y }, end])
}

export function routeWirePaths(wires: RoutedWire[], bounds: WireBounds[]): Map<string, string> {
  const paths = new Map<string, string>()
  const occupied: Segment[] = []
  const exits = new Map<string, number>()
  for (const wire of [...wires].sort((a, b) => a.start.y - b.start.y || a.start.x - b.start.x || a.end.y - b.end.y || a.end.x - b.end.x || a.id.localeCompare(b.id))) {
    const exit = (port: WirePort) => {
      const key = `${port.component}:${port.x}:${port.y}`
      const count = exits.get(key) ?? 0
      exits.set(key, count + 1)
      return exitPoint(port, bounds, count * spacing)
    }
    const startExit = exit(wire.start)
    const endExit = exit(wire.end)
    const points = simplify([wire.start, ...routeBetween(startExit, endExit, bounds, occupied), wire.end])
    for (let index = 1; index < points.length; index++) occupied.push({ start: points[index - 1], end: points[index] })
    paths.set(wire.id, roundedOrthogonalPath(points, 8))
  }
  return paths
}

export function roundedWirePath(start: WirePoint, end: WirePoint, radius = 12): string {
  const middleX = (start.x + end.x) / 2
  return roundedOrthogonalPath([start, { x: middleX, y: start.y }, { x: middleX, y: end.y }, end], radius)
}
