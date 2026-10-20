/**
 * The line-owning sensor contract. Import this module (not its files) so the
 * built-in models register themselves; a new device adds one file under
 * `./models/` and one import line here.
 */

export * from './padEvent';
export { PadBus } from './padBus';
export * from './LineTimeline';
export * from './lineModels';
export * from './LineHost';
export { LineSensorHub } from './LineSensorHub';
export * from './requestLine';
// The membrane keypad's circuit, on its own: a host with no guest clock (a
// Linux guest reading its pins over a link) cannot run the hub, but it can
// still solve the matrix. See models/matrix-keypad.
export { heldKeys, solveKeypad, wireList } from './models/matrix-keypad';
export type { WirePad, WireTarget } from './models/matrix-keypad';

import './models';
