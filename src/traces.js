// Traces of minification on a page: for options that leave a page unchanged, whether it holds what
// they act on, all in the form they produce (in effect already), rather than nothing to act on;
// options that remove things leave no traces, as what’s missing may never have been there

import { parse } from 'parse5';
import { walk } from './hazards.js';

/** @typedef {import('parse5').DefaultTreeAdapterMap['element']} Element */
/** @typedef {{name: string, value: string, raw: string, element: Element}} Attribute */
/** @typedef {{attributes: Attribute[], texts: string[], textsRaw: string[], styles: string[], scripts: string[], json: string[], foreign: {element: Element, raw: string}[], doctype: {name: string, publicId: string, systemId: string} | null}} Page */

// Attributes HTML Minifier collapses as boolean
const BOOLEAN = new Set(['allowfullscreen', 'async', 'autofocus', 'autoplay', 'checked', 'compact', 'controls', 'declare', 'default', 'defaultchecked', 'defaultmuted', 'defaultselected', 'defer', 'disabled', 'enabled', 'formnovalidate', 'hidden', 'indeterminate', 'inert', 'ismap', 'itemscope', 'loop', 'multiple', 'muted', 'nohref', 'nomodule', 'noresize', 'noshade', 'novalidate', 'nowrap', 'open', 'pauseonexit', 'playsinline', 'readonly', 'required', 'reversed', 'scoped', 'seamless', 'selected', 'sortable', 'truespeed', 'typemustmatch', 'visible']);
const TYPES_JS = new Set(['', 'module', 'text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript']);
const TYPES_JSON = new Set(['application/json', 'application/ld+json', 'importmap', 'speculationrules', 'application/manifest+json']);
// Where whitespace is kept or isn’t text
const RAW_TEXT = new Set(['pre', 'textarea', 'script', 'style', 'template', 'noscript']);
// What `decodeEntities` keeps: markup characters
const RE_ENTITY_KEPT = /^&(?:amp|lt|gt|quot|apos|#0*(?:34|38|39|60|62)|#x0*(?:22|26|27|3c|3e));$/i;
const RE_ENTITY = /&(?:[a-z][a-z\d]*|#\d+|#x[\da-f]+);/gi;
const RE_UNQUOTABLE = /^[^\s"'`=<>]+$/;
// Whitespace around CSS punctuation, or line breaks
const RE_CSS_LOOSE = /\n|\s[{}:;,>]|[{}:;,]\s/;
const RE_JS_LOOSE = /\n|\s[=+*{}();,:]|[=+*{}();,:]\s|;$/;
const RE_WHITESPACE_LOOSE = /\s{2,}|[\t\n\r\f]/;

/** @param {Element} element */
const insideRaw = (element) => {
  for (let node = /** @type {Element | null} */ (element); node; node = /** @type {Element | null} */ (node.parentNode)) {
    // In parsed documents, only template contents are fragments, which don’t lead back to templates
    if (/** @type {{nodeName: string}} */ (node).nodeName === '#document-fragment') return true;
    if ('tagName' in node && RAW_TEXT.has(node.tagName)) return true;
  }
  return false;
};

/** @param {string} html */
function read(html) {
  /** @type {Page} */
  const page = { attributes: [], texts: [], textsRaw: [], styles: [], scripts: [], json: [], foreign: [], doctype: null };
  walk(parse(html, { sourceCodeLocationInfo: true }), (node) => {
    if (node.nodeName === '#documentType' && 'publicId' in node) {
      page.doctype = { name: node.name, publicId: node.publicId, systemId: node.systemId };
    } else if (node.nodeName === '#text' && 'value' in node) {
      if (!insideRaw(/** @type {Element} */ (node.parentNode))) {
        page.texts.push(node.value);
        const location = node.sourceCodeLocation;
        if (location) page.textsRaw.push(html.slice(location.startOffset, location.endOffset));
      }
    } else if ('tagName' in node) {
      const location = node.sourceCodeLocation;
      for (const { name, value } of node.attrs) {
        const at = location?.attrs?.[name];
        if (at) page.attributes.push({ name, value, raw: html.slice(at.startOffset, at.endOffset), element: node });
      }
      const text = node.childNodes.map((child) => 'value' in child ? child.value : '').join('');
      const type = (node.attrs.find((item) => item.name === 'type')?.value ?? '').trim().toLowerCase();
      if (node.tagName === 'style' && text.trim()) page.styles.push(text);
      if (node.tagName === 'script' && text.trim() && !node.attrs.some((item) => item.name === 'src')) {
        if (TYPES_JS.has(type)) page.scripts.push(text);
        if (TYPES_JSON.has(type)) page.json.push(text);
      }
      if (node.namespaceURI !== 'http://www.w3.org/1999/xhtml' && location?.startTag && !node.childNodes.length) {
        page.foreign.push({ element: node, raw: html.slice(location.startTag.startOffset, location.startTag.endOffset) });
      }
    }
  });
  return page;
}

/** @param {Attribute} attribute */
const isBare = (attribute) => !attribute.raw.includes('=');
/** @param {Attribute} attribute */
const isQuoted = (attribute) => /=\s*["']/.test(attribute.raw);
/** @param {Attribute} attribute */
const isEvent = (attribute) => attribute.name.startsWith('on');

/**
 * Whether there are items, all in the form an option produces
 * @template T
 * @param {T[]} items
 * @param {(item: T) => boolean} isProduced
 */
const allProduced = (items, isProduced) => items.length > 0 && items.every(isProduced);

/** @param {string} json */
const isCompactJson = (json) => {
  try {
    return JSON.stringify(JSON.parse(json)) === json;
  } catch {
    return false;
  }
};

/** @type {Record<string, (page: Page) => boolean>} */
const DETECTORS = {
  collapseAttributeWhitespace: ({ attributes }) => attributes.some(({ value }) => /\S \S/.test(value)) && !attributes.some(({ value }) => value !== value.trim() || RE_WHITESPACE_LOOSE.test(value)),
  collapseBooleanAttributes: ({ attributes }) => allProduced(attributes.filter(({ name }) => BOOLEAN.has(name)), isBare),
  collapseEmptyAttributes: ({ attributes }) => allProduced(attributes.filter((attribute) => !BOOLEAN.has(attribute.name) && (isBare(attribute) || !attribute.value)), isBare),
  collapseWhitespace: ({ texts }) => texts.some((text) => /\S/.test(text)) && !texts.some((text) => RE_WHITESPACE_LOOSE.test(text)),
  decodeEntities: ({ attributes, textsRaw }) => {
    const raw = [...textsRaw, ...attributes.map((attribute) => attribute.raw)];
    return raw.some((text) => /[^\t\n\r\f -~]/.test(text)) && !raw.some((text) => (text.match(RE_ENTITY) ?? []).some((entity) => !RE_ENTITY_KEPT.test(entity)));
  },
  minifyCSS: ({ attributes, styles }) => allProduced([...styles, ...attributes.filter(({ name, value }) => name === 'style' && value.trim()).map(({ value }) => value)], (css) => !RE_CSS_LOOSE.test(css.trim()) && css === css.trim()),
  minifyJS: ({ attributes, scripts }) => allProduced([...scripts, ...attributes.filter((attribute) => isEvent(attribute) && attribute.value.trim()).map(({ value }) => value)], (js) => !RE_JS_LOOSE.test(js) && js === js.trim()),
  minifyJSON: ({ json }) => allProduced(json, isCompactJson),
  removeAttributeQuotes: ({ attributes }) => {
    const valued = attributes.filter((attribute) => !isBare(attribute));
    return valued.some((attribute) => !isQuoted(attribute)) && !valued.some((attribute) => isQuoted(attribute) && RE_UNQUOTABLE.test(attribute.value));
  },
  selfCloseForeignElements: ({ foreign }) => allProduced(foreign, ({ raw }) => raw.endsWith('/>')),
  useShortDoctype: ({ doctype }) => doctype !== null && doctype.name.toLowerCase() === 'html' && !doctype.publicId && !doctype.systemId
};

// Options that can leave traces
export const TRACED = Object.keys(DETECTORS);

/**
 * Options the page shows traces of
 * @param {string} html
 * @returns {Set<string>}
 */
export function tracesOf(html) {
  const page = read(html);
  return new Set(TRACED.filter((name) => DETECTORS[name]?.(page)));
}