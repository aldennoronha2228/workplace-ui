/**
 * Component taxonomy — the two-level tree the picker's left rail navigates.
 *
 * The catalogue passed 400 parts, at which point a single flat grid behind one
 * category dropdown stopped being navigable: "Sensors" alone holds a third of
 * everything. This module is the one place that answers two questions:
 *
 *   1. Which top-level category does a part belong to?  `normalizeCategory`
 *   2. Which subgroup inside that category?             `subcategoryOf`
 *
 * Subgroups are DERIVED, not authored: each rule is a regex tested against the
 * part's name, id, tags and description. That keeps the 400+ existing metadata
 * entries (and every one a private overlay injects at runtime) working with no
 * per-part annotation, and it means a new Grove SKU lands in the right branch
 * the day it is registered.
 *
 * Rule order is significant — the FIRST match wins, so the specific rules are
 * listed before the general ones. A BME280 reads as temperature+humidity
 * before it reads as a barometer; a BME688 reads as a gas sensor before
 * either. When nothing matches, the part falls into the category's own
 * catch-all subgroup, which always sorts last.
 */

import type { ComponentCategory, ComponentMetadata } from '../types/component-metadata';

/**
 * Maker-first category order for the tree and the grid sections.
 * Velxio's audience is hobbyist-heavy: everyday digital parts (sensors,
 * LEDs/outputs, displays, buttons) lead, while diodes/resistors/capacitors
 * ('passive'), transistors/op-amps/instruments ('analog') and logic gates
 * sink to the end of the list.
 */
export const CATEGORY_ORDER: ComponentCategory[] = [
  'sensors',
  'output',
  'displays',
  'input',
  'motors',
  'communication',
  'connectivity',
  'electromech',
  'boards',
  'other',
  'passive',
  'analog',
  'logic',
];

/** Every category the registry is allowed to report, as a lookup. */
const KNOWN_CATEGORIES = new Set<string>(CATEGORY_ORDER);

/**
 * Spelling fixes for categories that reached the metadata by hand.
 * `sensor` (singular) shipped on the BMP280 and showed up in the old dropdown
 * as its own one-item entry sitting right next to "Sensors".
 */
const CATEGORY_ALIASES: Record<string, ComponentCategory> = {
  sensor: 'sensors',
  display: 'displays',
  outputs: 'output',
  inputs: 'input',
  motor: 'motors',
  comms: 'communication',
  wireless: 'communication',
  power: 'analog',
};

/**
 * Fold a raw metadata category onto the declared set. Unknown values become
 * 'other' rather than minting a tree branch of one, which is what the picker
 * used to do with any typo or any category a runtime overlay invented.
 */
export function normalizeCategory(raw: string | undefined | null): ComponentCategory {
  if (!raw) return 'other';
  const key = String(raw).trim().toLowerCase();
  if (KNOWN_CATEGORIES.has(key)) return key as ComponentCategory;
  return CATEGORY_ALIASES[key] ?? 'other';
}

export function categoryRank(category: string): number {
  const i = CATEGORY_ORDER.indexOf(normalizeCategory(category));
  return i === -1 ? CATEGORY_ORDER.indexOf('other') : i;
}

export interface SubcategoryDef {
  /** Stable id used in the tree key and in persisted UI state. */
  id: string;
  /** Human label for the tree node and the grid section header. */
  label: string;
  /**
   * Tested against the part's searchable text. Omitted on the catch-all
   * subgroup, which every unmatched part in the category falls into.
   */
  match?: RegExp;
  /**
   * Veto: a part matching this is NOT claimed by the rule even if `match`
   * hits, and carries on down the list. Needed where one reading of a
   * multi-sensor part should outrank another that appears earlier in its
   * name -- a BME280 says "Temp & Humi & Barometer" and belongs with the
   * humidity sensors, while a BMP280 says "Temperature and Barometer" and
   * belongs with the barometers.
   */
  exclude?: RegExp;
}

/**
 * Subgroups per category, in display order, catch-all last.
 *
 * A category absent from this map is not subdivided: the tree shows it as a
 * leaf and the grid gets one section for it. That is deliberate for the small
 * ones (Electromechanical has five parts; splitting it would add clicks and
 * remove nothing).
 */
export const SUBCATEGORIES: Partial<Record<ComponentCategory, SubcategoryDef[]>> = {
  sensors: [
    {
      id: 'imaging',
      label: 'Imaging & thermal cameras',
      match: /thermal imag|ir array|mlx9064|mlx9062|\bcamera\b|vision ai|ov5647|\bcsi\b/,
    },
    {
      id: 'biometric',
      label: 'Biometric',
      match: /heart|\becg\b|\bemg\b|\bgsr\b|pulse|fingerprint|\bspo2\b|blood|skin response/,
    },
    { id: 'position', label: 'Position & GPS', match: /\bgps\b|\bgnss\b|neo-?6m|air530/ },
    {
      id: 'sound',
      label: 'Sound & microphones',
      match: /microphone|sound sensor|\bmic\b|respeaker|\bmems\b.*(mic|sound)|big sound|small sound/,
    },
    {
      id: 'air',
      label: 'Air quality & gas',
      match:
        /\bco2\b|carbon dioxide|\bvoc\b|\bnox\b|air quality|gas sensor|\bgas\b|formaldehyde|\bhcho\b|dust|pm ?2\.5|particulate|sgp\d|scd\d|sen5\d|mh-?z|\bmq-?\d|multichannel|alcohol|ozone|bme68/,
    },
    {
      id: 'pressure',
      label: 'Pressure & altitude',
      match: /barometer|barometric|pressure|altimeter|\bbmp\d|dps310|spa06|\bmpx\d/,
      // A part that also reads humidity is an environmental sensor first.
      exclude: /humidit|humi[&\s]|\bsht\d|\baht\d|\bdht\d|\bbme2/,
    },
    {
      id: 'temp',
      label: 'Temperature & humidity',
      match:
        /humidit|humi[&\s]|\bdht\d|\bsht\d|\baht\d|\bhdc\d|temperature|thermocouple|thermometer|\brtd\b|pt100|\bntc\b|ds18b20|max31\d|max66\d|mcp9\d|mlx906/,
    },
    {
      id: 'distance',
      label: 'Distance & proximity',
      match:
        /ultrasonic|hc-?sr04|time of flight|\btof\b|vl53|proximity|gp2y|distance|radar|doppler|mmwave|\bus5\b|ranging|lidar/,
    },
    {
      id: 'motion',
      label: 'Motion & orientation',
      match:
        /accelerom|gyroscop|\bgyro\b|\bimu\b|compass|magnetomet|\d ?dof\b|step counter|adxl|lis3dh|\bbma\d|\bmpu\d|\bicm\d|as5600|rotary position|inclinomet/,
    },
    {
      id: 'light',
      label: 'Light & colour',
      match:
        /light sensor|photoresist|photodiode|\bldr\b|\blux\b|luminos|tsl\d|colou?r sensor|\buv\b|veml|guva|ambient light|illuminance/,
    },
    {
      id: 'presence',
      label: 'Presence & vibration',
      match:
        /\bpir\b|motion|presence|occupancy|collision|vibration|sw-?420|lightning|as3935|\bd7s\b|seismic|reflective|line finder|interrupter|\btilt\b/,
    },
    {
      id: 'liquid',
      label: 'Water & soil',
      match: /soil|moisture|water|\btds\b|turbidit|\bph\b|\borp\b|liquid|leak|water level|\bflow\b/,
    },
    {
      id: 'force',
      label: 'Force, angle & encoders',
      match: /\bforce\b|\bfsr\b|strain|weight|load cell|hx711|piezo|angle sensor|potentiometer|encoder/,
    },
    {
      id: 'electrical',
      label: 'Current & voltage',
      match:
        /current sensor|voltage|\badc\b|\bacs\d|\bads1\d|inductive|\bldc\d|divider|transformer|power monitor|\bina\d/,
    },
    { id: 'misc', label: 'Other sensors' },
  ],

  output: [
    {
      id: 'leds',
      label: 'LEDs & addressable pixels',
      match: /\bled\b|neopixel|ws28\d|sk68|pixel|bar graph|\bcob\b|light string/,
    },
    {
      id: 'audio',
      label: 'Buzzers & speakers',
      match: /buzzer|speaker|piezo|\baudio\b|amplifier|recorder|siren/,
    },
    {
      id: 'switching',
      label: 'Relays & switching',
      match: /relay|mosfet|optocoupler|latching|\bspdt\b|reed|triac|solid state/,
    },
    { id: 'misc', label: 'Other output' },
  ],

  displays: [
    { id: 'epaper', label: 'e-Paper & e-ink', match: /epaper|e-?paper|e-?ink/ },
    { id: 'oled', label: 'OLED', match: /\boled\b|ssd13\d|sh11\d|sh10\d/ },
    {
      id: 'lcd',
      label: 'Character LCD',
      match: /\blcd\b|16 ?x ?2|20 ?x ?4|1602|2004|character display/,
    },
    {
      id: 'tft',
      label: 'TFT & colour screens',
      match: /\btft\b|ili9\d|gc9a01|st77\d|\bips\b|round display|touch screen/,
    },
    {
      id: 'matrix',
      label: 'LED matrix & segment',
      match: /matrix|segment|\bdigit\b|alphanumeric|nixie|led bar|chainable|circular led|strip driver|ht16k33|my9221/,
    },
    { id: 'misc', label: 'Other displays' },
  ],

  input: [
    {
      id: 'gesture',
      label: 'Gesture & vision',
      match: /gesture|huskylens|vision|paj76|pag76|voice recognit|speech/,
    },
    {
      id: 'touch',
      label: 'Touch & keypads',
      match: /touch|capacitive|keypad|mpr121|fingerprint|keycap|membrane/,
    },
    {
      id: 'knobs',
      label: 'Knobs, encoders & joysticks',
      match: /encoder|potentiometer|joystick|\bdial\b|rotary|slide pot|\bwheel\b/,
    },
    {
      id: 'buttons',
      label: 'Buttons & switches',
      match: /button|switch|\bdip\b|micro switch|magnetic switch|toggle/,
    },
    { id: 'misc', label: 'Other input' },
  ],

  motors: [
    {
      id: 'drivers',
      label: 'Motor drivers',
      match: /driver|\bl298|\bl293|tb6612|a4988|pca9685|\bpwm\b|h-?bridge/,
    },
    { id: 'motors', label: 'Motors, servos & fans', match: /motor|servo|\bfan\b|stepper|haptic|vibration/ },
    { id: 'misc', label: 'Other motion' },
  ],

  communication: [
    {
      id: 'wireless',
      label: 'WiFi, Bluetooth & LoRa',
      match: /wifi|wi-?fi|bluetooth|\bble\b|esp82|wizfi|\blora\b|\d{3} ?mhz|wio-?e5|zigbee|\bhm1\d/,
    },
    { id: 'tags', label: 'RFID & NFC', match: /\brfid\b|\bnfc\b|pn53\d|st25|125 ?khz|mifare/ },
    { id: 'ai', label: 'Voice & AI modules', match: /voice|speech|recogni|vision ai/ },
    {
      id: 'serial',
      label: 'Serial, bus & IR',
      match: /rs2\d\d|rs4\d\d|\buart\b|\bcan\b|\bi2c\b|\bspi\b|infrared|\bir\b|multiplexer|serial/,
    },
    { id: 'misc', label: 'Other comms' },
  ],

  analog: [
    {
      id: 'transistors',
      label: 'Transistors & MOSFETs',
      match: /\bbjt\b|mosfet|transistor|\b2n\d{4}\b|\bbc\d{3}\b|irf\d|fqp\d/,
    },
    { id: 'diodes', label: 'Diodes', match: /diode|zener|schottky|rectifier|\b1n\d{4}\b/ },
    { id: 'opamps', label: 'Op-amps & comparators', match: /op-?amp|lm3\d\d|lm7\d\d|tl0\d\d|comparator/ },
    {
      id: 'power',
      label: 'Power & regulators',
      match: /regulator|battery|power supply|\b78\d\d\b|\b79\d\d\b|lm317|coin cell/,
    },
    {
      id: 'instruments',
      label: 'Instruments & converters',
      match: /voltmeter|ammeter|oscillo|signal generator|\badc\b|\bdac\b|mcp3\d|probe/,
    },
    { id: 'misc', label: 'Other analog' },
  ],

  logic: [
    { id: 'ics', label: '74xx logic ICs', match: /\b74[a-z]*\d{2,}/ },
    { id: 'flipflops', label: 'Flip-flops', match: /flip-?flop|latch|register/ },
    { id: 'gates', label: 'Logic gates', match: /\bgate\b|inverter|\bnand\b|\bnor\b|\bxor\b|\bxnor\b/ },
    { id: 'misc', label: 'Other logic' },
  ],

  passive: [
    { id: 'breadboards', label: 'Breadboards', match: /breadboard|franzininho|perfboard|protoboard/ },
    { id: 'resistors', label: 'Resistors', match: /resistor|\bohm\b|\bΩ/ },
    { id: 'capacitors', label: 'Capacitors', match: /capacitor|\bcap\.|electrolytic|\bfarad\b|\bµf\b|\bnf\b|\bpf\b/ },
    { id: 'inductors', label: 'Inductors', match: /inductor|\bcoil\b|\bmh\b|\bµh\b/ },
    { id: 'misc', label: 'Other passives' },
  ],
};

/** The subgroup a part falls into when none of its category's rules match. */
const CATCH_ALL = 'misc';

/**
 * The text a subcategory rule is tested against. Name and id first because
 * they are what the rules key on; tags and description catch the parts whose
 * name says nothing useful ("Grove - Recorder v3.0" is only an audio part
 * because its description says so).
 */
function haystackOf(c: ComponentMetadata): string {
  return [c.name, c.id, (c.tags ?? []).join(' '), c.description ?? '']
    .join(' ')
    .toLowerCase();
}

/**
 * Cached per metadata OBJECT, not per id: `mergeComponents` replaces the
 * object whenever an overlay re-registers a part, so a stale classification
 * can never be served, and the map never keeps a dropped part alive.
 */
const subcategoryCache = new WeakMap<ComponentMetadata, string>();

/**
 * Subgroup id for a part, or '' when its category is not subdivided.
 */
export function subcategoryOf(component: ComponentMetadata): string {
  const cached = subcategoryCache.get(component);
  if (cached !== undefined) return cached;

  const category = normalizeCategory(component.category);
  const defs = SUBCATEGORIES[category];
  let result = '';
  if (defs) {
    const haystack = haystackOf(component);
    result = CATCH_ALL;
    for (const def of defs) {
      if (!def.match || !def.match.test(haystack)) continue;
      if (def.exclude && def.exclude.test(haystack)) continue;
      result = def.id;
      break;
    }
  }
  subcategoryCache.set(component, result);
  return result;
}

/** Display label for a subgroup, falling back to its id if it is unknown. */
export function subcategoryLabel(category: ComponentCategory, subId: string): string {
  const defs = SUBCATEGORIES[normalizeCategory(category)];
  return defs?.find((d) => d.id === subId)?.label ?? subId;
}

const displayOrderCache = new Map<string, SubcategoryDef[]>();

/**
 * The subgroups of a category in READING order, which is not the order the
 * table declares them in.
 *
 * The table is ordered by matching precedence, so the narrowest rule comes
 * first -- which put "Imaging & thermal cameras" (5 parts) at the top of the
 * sensors branch and "Temperature & humidity" (22) seven rows down. Precedence
 * is an implementation detail; a list of fifteen branches is scanned
 * alphabetically. The catch-all is pinned last whatever it is called.
 */
export function subcategoryDefsInDisplayOrder(category: ComponentCategory): SubcategoryDef[] {
  const key = normalizeCategory(category);
  const cached = displayOrderCache.get(key);
  if (cached) return cached;
  const order = [...(SUBCATEGORIES[key] ?? [])].sort((a, b) => {
    if (!a.match !== !b.match) return a.match ? -1 : 1;
    return a.label.localeCompare(b.label, 'en');
  });
  displayOrderCache.set(key, order);
  return order;
}

/** Rank of a subgroup inside its category, for ordering the grid sections. */
export function subcategoryRank(category: ComponentCategory, subId: string): number {
  const order = subcategoryDefsInDisplayOrder(category);
  const i = order.findIndex((d) => d.id === subId);
  return i === -1 ? order.length : i;
}

/** Tree/section key for a category, and for a category + subgroup. */
export function categoryKey(category: ComponentCategory): string {
  return `cat:${category}`;
}

export function subcategoryKey(category: ComponentCategory, subId: string): string {
  return subId ? `cat:${category}/${subId}` : `cat:${category}`;
}
