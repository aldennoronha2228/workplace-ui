// @vitest-environment jsdom
/**
 * Every thumbnail the property dialog draws is well-formed XML.
 *
 * Since the dialog draws a part's thumbnail as an <img> data URL (PR #370),
 * the SVG is parsed as XML, and a single invalid token drops the whole
 * picture: five Grove headers ("Temp & Humi", "VOC & eCO2" in the silk) came
 * out empty on velxio.dev. Inline in HTML the same markup had been tolerated.
 * The catalogue's own thumbnails are checked here as the dialog prepares
 * them; the overlay's are checked by its own suite with the same parse.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ComponentMetadata } from '../types/component-metadata';
import { scalableSvgThumbnail } from '../utils/svgThumbnail';

/** What the <img> does with the data URL: an XML parse. null when it parses. */
function xmlError(svg: string): string | null {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const err = doc.getElementsByTagName('parsererror')[0];
  if (err) return err.textContent?.slice(0, 160) ?? 'parsererror';
  return doc.documentElement.localName === 'svg'
    ? null
    : `root is <${doc.documentElement.localName}>`;
}

const META: ComponentMetadata[] = JSON.parse(
  readFileSync(resolve(process.cwd(), 'public/components-metadata.json'), 'utf-8'),
).components;

describe('SVG thumbnails as the dialog draws them', () => {
  it('the parse used here does reject a bare ampersand (the check can fail)', () => {
    expect(
      xmlError('<svg xmlns="http://www.w3.org/2000/svg"><text>Temp & Humi</text></svg>'),
    ).not.toBeNull();
  });

  it('a label with a bare & still decodes: scalableSvgThumbnail writes it as &amp;', () => {
    const raw =
      '<svg width="64" height="64" xmlns="http://www.w3.org/2000/svg"><text x="1" y="9">Temp & Humi</text><text>VOC & eCO2</text></svg>';
    const prepared = scalableSvgThumbnail(raw)!;
    expect(xmlError(prepared)).toBeNull();
    expect(
      new DOMParser().parseFromString(prepared, 'image/svg+xml').documentElement.textContent,
    ).toBe('Temp & HumiVOC & eCO2');
  });

  it('entities and character references are left as they are', () => {
    const raw =
      '<svg width="64" height="64" xmlns="http://www.w3.org/2000/svg"><text>a &amp; b &lt; c &#176; &#x3bc;</text></svg>';
    expect(scalableSvgThumbnail(raw)).toContain('a &amp; b &lt; c &#176; &#x3bc;');
    expect(xmlError(scalableSvgThumbnail(raw)!)).toBeNull();
  });

  it('every catalogue thumbnail is well-formed XML', () => {
    const svgs = META.flatMap((m) => {
      const t = scalableSvgThumbnail(m.thumbnail);
      return t ? [[m.id, t] as const] : [];
    });
    expect(svgs.length).toBeGreaterThan(40);
    const broken = svgs.flatMap(([id, t]) => {
      const e = xmlError(t);
      return e ? [`${id}: ${e}`] : [];
    });
    expect(broken).toEqual([]);
  });
});
