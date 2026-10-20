/**
 * The canvas's generic pin echo: what a part wired to a board pin hears when
 * that pin changes level.
 *
 * A part with its own simulation logic (attachEvents) draws its own state, and
 * SPICE-mapped parts and breadboards are left alone (see SimulatorCanvas for
 * why). Every other part gets the level written into its properties as
 * `state` / `value`, which is how the plain wokwi outputs light up.
 *
 * Which of the two a part is gets decided when the pin CHANGES, not when the
 * canvas subscribes. Parts from an overlay (the pro Grove bricks, every part
 * whose metadata and logic arrive with a dynamic import) are on the canvas
 * before their logic is registered: a project or a restored draft lists them
 * at once, and the subscription effect runs before the overlay lands. Deciding
 * at subscription time took such a part for a plain output for as long as the
 * effect did not re-run, so a level that moved in that window (an I2C bus
 * putting its pull-ups on SDA and SCL as the first part on it attaches) wrote
 * `state: false` into the part's properties. The canvas then assigned that
 * property to the element, whose own `state` is its drawing state, and the
 * drawing threw on its first paint, taking the editor with it; the saved
 * project kept the stray `state` for good.
 *
 * A part the app does not know yet (no metadata, no logic) is not echoed at
 * all: nothing can draw it, and nothing may be written into its project
 * properties on its behalf. Its logic is also looked up per change, so it
 * starts getting onPinStateChange the moment it registers.
 */
import type { PartSimulationLogic } from '../../simulation/parts/PartSimulationRegistry';

export interface PinStateEchoOptions {
  componentId: string;
  metadataId: string;
  /** The part's own pin on the wire ('A' for a properties.pin part). */
  componentPinName?: string;
  /** Subscribed through a wire (as opposed to properties.pin): the echo then
   *  needs a GND wire before it lights anything. */
  wireConnected: boolean;
  hasGndWire: () => boolean;
  /** The part's metadata is registered (ComponentRegistry). */
  isKnownPart: (metadataId: string) => boolean;
  /** SPICE-mapped parts and breadboards: never echoed. */
  ownsVisualsAnyway: (metadataId: string) => boolean;
  getLogic: (metadataId: string) => PartSimulationLogic | undefined;
  updateComponentState: (componentId: string, state: boolean) => void;
  getElement?: (componentId: string) => HTMLElement | null;
}

export function pinStateEchoHandler(o: PinStateEchoOptions): (pin: number, state: boolean) => void {
  let gnd: boolean | undefined;
  const hasGnd = (selfManaged: boolean): boolean => {
    if (!o.wireConnected || selfManaged) return true;
    if (gnd === undefined) gnd = o.hasGndWire();
    return gnd;
  };
  const elementOf = o.getElement ?? ((id: string) => document.getElementById(id));
  return (_pin, state) => {
    const logic = o.getLogic(o.metadataId);
    const selfManaged = !!logic?.attachEvents || o.ownsVisualsAnyway(o.metadataId);
    const level = hasGnd(selfManaged) && state;
    if (!selfManaged && (logic || o.isKnownPart(o.metadataId))) {
      o.updateComponentState(o.componentId, level);
    }
    if (logic?.onPinStateChange) {
      const el = elementOf(o.componentId);
      if (el) logic.onPinStateChange(o.componentPinName || 'A', level, el);
    }
  };
}
