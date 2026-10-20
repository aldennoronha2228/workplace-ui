/**
 * The picker's left rail is only as good as this classifier: a part that lands
 * in the wrong branch is a part the user cannot browse to. These cases are the
 * ones the rules were written against, including the near-misses that made the
 * first draft wrong (an IR thermometer is not a thermal camera; a load cell is
 * a force sensor, not an ADC).
 */
import { describe, it, expect } from 'vitest';
import {
  CATEGORY_ORDER,
  SUBCATEGORIES,
  categoryRank,
  normalizeCategory,
  subcategoryKey,
  subcategoryDefsInDisplayOrder,
  subcategoryLabel,
  subcategoryOf,
  subcategoryRank,
} from '../data/componentTaxonomy';
import type { ComponentCategory, ComponentMetadata } from '../types/component-metadata';

function part(
  name: string,
  category: string,
  extra: Partial<ComponentMetadata> = {},
): ComponentMetadata {
  return {
    id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    tagName: 'wokwi-test',
    name,
    category: category as ComponentCategory,
    thumbnail: '',
    properties: [],
    defaultValues: {},
    pinCount: 2,
    tags: [],
    ...extra,
  };
}

describe('normalizeCategory', () => {
  it('folds the singular spelling that shipped on the BMP280', () => {
    expect(normalizeCategory('sensor')).toBe('sensors');
  });

  it('keeps every declared category as-is', () => {
    for (const c of CATEGORY_ORDER) expect(normalizeCategory(c)).toBe(c);
  });

  it('sends anything unknown to "other" instead of minting a branch of one', () => {
    expect(normalizeCategory('basics')).toBe('other');
    expect(normalizeCategory('')).toBe('other');
    expect(normalizeCategory(undefined)).toBe('other');
  });

  it('is case and whitespace tolerant', () => {
    expect(normalizeCategory('  Sensors ')).toBe('sensors');
  });
});

describe('categoryRank', () => {
  it('puts everyday parts before the passive tail', () => {
    expect(categoryRank('sensors')).toBeLessThan(categoryRank('passive'));
    expect(categoryRank('output')).toBeLessThan(categoryRank('logic'));
  });

  it('ranks an unknown category where "other" sits', () => {
    expect(categoryRank('nonsense')).toBe(categoryRank('other'));
  });
});

describe('subcategoryOf', () => {
  const cases: Array<[string, string, string]> = [
    // The three-way overlap between the Bosch environmental parts: whichever
    // reading is the headline one wins, gas first, then humidity, then pressure.
    ['Grove - Air Quality Sensor(BME688) 4-in-1 Gas, Humidity, Pressure', 'sensors', 'air'],
    ['Grove - Temp&Humi&Barometer Sensor (BME280)', 'sensors', 'temp'],
    ['Grove Temperature and Barometer Sensor (BMP280)', 'sensors', 'pressure'],
    ['Grove - High Precision Barometric Pressure Sensor (DPS310)', 'sensors', 'pressure'],
    // An MLX90614 is a single-point IR thermometer; an MLX90640 is an IR array.
    ['Grove - Single-Point Infrared Thermometer - MLX90614', 'sensors', 'temp'],
    ['Grove - Thermal Imaging Camera / IR Array MLX90640', 'sensors', 'imaging'],
    ['HC-SR04', 'sensors', 'distance'],
    ['MPU6050', 'sensors', 'motion'],
    ['PIR Motion Sensor', 'sensors', 'presence'],
    ['Photoresistor Sensor', 'sensors', 'light'],
    ['GPS NEO-6M', 'sensors', 'position'],
    ['Grove - Ear-clip Heart Rate Sensor', 'sensors', 'biometric'],
    ['Grove - Capacitive Soil Moisture Sensor', 'sensors', 'liquid'],
    ['Grove - 2.5A DC Current Sensor(ACS70331)', 'sensors', 'electrical'],
    // Force beats the voltage rule: these read a mechanical quantity even
    // though their datasheets are full of the word "voltage".
    ['Grove - ADC for Load Cell (HX711)', 'sensors', 'force'],
    ['Grove - Rotary Angle Sensor', 'sensors', 'force'],
    ['NeoPixel Matrix', 'output', 'leds'],
    ['Grove - Piezo Buzzer', 'output', 'audio'],
    ['Relay (SPDT)', 'output', 'switching'],
    ['ePaper 2.9" (296x128, B/W)', 'displays', 'epaper'],
    ['SSD1306 OLED', 'displays', 'oled'],
    ['LCD 16x2 (I2C)', 'displays', 'lcd'],
    ['Pushbutton', 'input', 'buttons'],
    ['KY-040 Rotary Encoder', 'input', 'knobs'],
    ['Grove - 12 Key Capacitive I2C Touch Sensor', 'input', 'touch'],
    ['A4988 Stepper Driver', 'motors', 'drivers'],
    ['Servo', 'motors', 'motors'],
    ['Grove - UART WiFi V2 (ESP8285)', 'communication', 'wireless'],
    ['Grove - NFC (PN532)', 'communication', 'tags'],
    ['Grove - Offline Voice Recognition Module', 'communication', 'ai'],
    ['2N2222 (NPN BJT)', 'analog', 'transistors'],
    ['1N4148 (Small-Signal Diode)', 'analog', 'diodes'],
    ['LM358 (Dual Op-Amp)', 'analog', 'opamps'],
    ['7805 (+5V Linear Regulator)', 'analog', 'power'],
    ['74HC00 (Quad 2-input NAND)', 'logic', 'ics'],
    ['XOR Gate', 'logic', 'gates'],
    ['D Flip-Flop', 'logic', 'flipflops'],
    ['Resistor 220 Ohm', 'passive', 'resistors'],
    ['Breadboard (full)', 'passive', 'breadboards'],
  ];

  it.each(cases)('%s (%s) lands in "%s"', (name, category, expected) => {
    expect(subcategoryOf(part(name, category))).toBe(expected);
  });

  it('separates the BME280 from the BMP280 by humidity, not by name order', () => {
    // Same word soup, one letter apart in the part number: the BME reads
    // humidity and the BMP does not, and that is the whole difference.
    const bme = part('BME280 Sensor', 'sensors', {
      tags: ['sensor', 'i2c', 'temperature', 'humidity', 'pressure', 'bme280'],
    });
    const bmp = part('BMP280 (Pressure + Temp)', 'sensor', {
      tags: ['sensor', 'i2c', 'pressure', 'temperature', 'bmp280', 'weather', 'barometer'],
    });
    expect(subcategoryOf(bme)).toBe('temp');
    // ...and the singular category it ships with must not strand it either.
    expect(normalizeCategory(bmp.category)).toBe('sensors');
    expect(subcategoryOf(bmp)).toBe('pressure');
  });

  it('lets a veto hand a part down to a later rule', () => {
    // "pressure" fires on both, but only one of them also reads humidity.
    expect(subcategoryOf(part('Weather Sensor', 'sensors', {
      description: 'Reads barometric pressure and relative humidity.',
    }))).toBe('temp');
    expect(subcategoryOf(part('Altitude Sensor', 'sensors', {
      description: 'Reads barometric pressure.',
    }))).toBe('pressure');
  });

  it('reads the tags and description, not just the name', () => {
    const p = part('Grove - Recorder v3.0', 'output', {
      description: 'Records and plays back audio through an onboard speaker.',
    });
    expect(subcategoryOf(p)).toBe('audio');
  });

  it('returns an empty subgroup for a category that is not subdivided', () => {
    expect(subcategoryOf(part('Relay (SPDT)', 'electromech'))).toBe('');
    expect(subcategoryOf(part('microSD Card', 'other'))).toBe('');
  });

  it('falls back to the catch-all rather than inventing a branch', () => {
    expect(subcategoryOf(part('Completely Unclassifiable Widget', 'sensors'))).toBe('misc');
  });

  it('classifies the same object identically on repeat calls (cache hit)', () => {
    const p = part('MPU6050', 'sensors');
    expect(subcategoryOf(p)).toBe(subcategoryOf(p));
  });
});

describe('subcategory tables', () => {
  for (const [category, defs] of Object.entries(SUBCATEGORIES)) {
    it(`${category}: ids are unique and the catch-all sorts last`, () => {
      const ids = defs!.map((d) => d.id);
      expect(new Set(ids).size).toBe(ids.length);

      // Exactly one rule-less entry, and it must be the final one, or parts
      // that match nothing would fall out of the tree entirely.
      const openEnded = defs!.filter((d) => !d.match);
      expect(openEnded).toHaveLength(1);
      expect(defs![defs!.length - 1].match).toBeUndefined();
    });

    it(`${category}: every subgroup has a label`, () => {
      for (const d of defs!) {
        expect(d.label.length).toBeGreaterThan(0);
        expect(subcategoryLabel(category as ComponentCategory, d.id)).toBe(d.label);
      }
    });

    it(`${category}: reading order is alphabetical with the catch-all last`, () => {
      const shown = subcategoryDefsInDisplayOrder(category as ComponentCategory);
      expect(shown).toHaveLength(defs!.length);
      expect(shown[shown.length - 1].match).toBeUndefined();

      const labels = shown.slice(0, -1).map((d) => d.label);
      expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b, 'en')));

      // The rank the grid sorts sections by is that same reading order.
      shown.forEach((d, i) => {
        expect(subcategoryRank(category as ComponentCategory, d.id)).toBe(i);
      });
    });
  }

  it('only subdivides categories the taxonomy ranks', () => {
    for (const category of Object.keys(SUBCATEGORIES)) {
      expect(CATEGORY_ORDER).toContain(category as ComponentCategory);
    }
  });
});

describe('subcategoryKey', () => {
  it('round-trips through the "cat:<category>/<subgroup>" form the rail uses', () => {
    expect(subcategoryKey('sensors', 'temp')).toBe('cat:sensors/temp');
    expect(subcategoryKey('sensors', 'temp').slice(4).split('/')).toEqual(['sensors', 'temp']);
  });

  it('drops the separator when the category is not subdivided', () => {
    expect(subcategoryKey('other', '')).toBe('cat:other');
  });
});
