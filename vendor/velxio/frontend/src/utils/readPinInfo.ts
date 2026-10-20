/**
 * A part element's `pinInfo`, read so that a broken part cannot throw.
 *
 * `pinInfo` is a getter on most elements, and on the data-driven ones (the pro
 * Grove bricks, the Velxio boards) it renders the part to find its pads. A
 * part whose drawing throws used to throw here too, from inside the effects
 * of PinOverlay and SeatedPinMarkers and the wire-position pass, and an error
 * in a React effect with nothing to catch it unmounts the whole editor. One
 * broken part now reads as a part with no pins (logged once per element).
 */
const warned = new WeakSet<object>();

export function readPinInfo<T = { name: string; x: number; y: number }>(
  element: Element | null | undefined,
): T[] | undefined {
  if (!element) return undefined;
  try {
    const info = (element as unknown as { pinInfo?: unknown }).pinInfo;
    return Array.isArray(info) ? (info as T[]) : undefined;
  } catch (e) {
    if (!warned.has(element)) {
      warned.add(element);
      console.error(`[part] ${element.id || element.tagName} could not report its pins:`, e);
    }
    return undefined;
  }
}
