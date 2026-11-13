// What a page’s own scripts and style sheets rely on that an option may change—found by comparing
// output with and without the option, and matching what changed against what the page references

import { parse } from 'parse5';

/**
 * `risk`: likely breaks the page; `check`: may break it, which a render check can settle;
 * `note`: can’t be ruled out
 * @typedef {{level: 'risk' | 'check' | 'note', message: string}} Hazard
 */

/**
 * @typedef {object} PageContext
 * @prop {Set<string>} scriptStrings Words in string literals of scripts and event handlers
 * @prop {string} scriptText
 * @prop {string[]} scriptsUnread Script URLs that couldn’t be read
 * @prop {Set<string>} attributeRefs Attribute names that style sheets select on or scripts query
 * @prop {{selector: string, text: string}[]} whitespaceRules Rules that keep whitespace, outside `pre` and `textarea`
 */

/** @typedef {import('parse5').DefaultTreeAdapterMap['node']} Node */
/** @typedef {import('parse5').DefaultTreeAdapterMap['element']} Element */

const MAX_PER_KIND = 3;

/** @type {Record<string, string>} */
const MODES = { 'quirks': 'quirks mode', 'limited-quirks': 'almost standards mode', 'no-quirks': 'standards mode' };
const RE_STRING_LITERAL = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
const RE_WORD = /[\w-]+/g;
const RE_ATTRIBUTE_SELECTOR = /\[\s*([\w-]+)\s*(?=[~|^$*]?=|\])/g;
const RE_CSS_COMMENT = /\/\*[\s\S]*?\*\//g;
// At-rules without a block, like `@import`, taking quoted strings and escapes whole
const RE_CSS_STATEMENT = /@[\w-]+(?:\\.|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|[^{};"'\\])*;/g;
const RE_IMPORT = /@import\s+(?:url\(\s*)?(["']?)([^"')\s;]+)\1/gi;
const RE_ATTRIBUTE_CALL = /\b(?:get|has|remove|set|toggle)Attribute(?:NS)?\(\s*(?:[^,()]*,\s*)?["'`]([\w-]+)/g;
const RE_WHITESPACE_KEPT = /white-space(?:-collapse)?\s*:\s*(?:pre-wrap|pre-line|pre|break-spaces|preserve-breaks|preserve-spaces|preserve)(?![\w-])/i;
const RE_READS_COMMENTS = /SHOW_COMMENT|COMMENT_NODE|nodeType\s*[!=]==?\s*8\b|\.childNodes\b[^;]*\.data\b/;
const RE_SCRIPT_JS = /^(?:|module|(?:application|text)\/(?:x-)?(?:java|ecma)script|text\/javascript1\.[0-5]|text\/jscript|text\/livescript)$/i;
const SELECTORS_PREFORMATTED = new Set(['pre', 'textarea']);

// Conditional comments only matter to Internet Explorer 9 and older
const RE_COMMENT_CONDITIONAL = /^\[if\b|<!\[endif\]$/i;
/** @type {[RegExp, string][]} */
const COMMENTS_MEANINGFUL = [
  [/^\s*\/?ko(?:\s|$)/, 'Knockout binding'],
  [/^\s*google(?:off|on)\s*:/i, 'search appliance directive'],
  [/^\s*\/?esi\b|^\s*<\/?esi:/i, 'Edge Side Includes'],
  [/^\?lit\$|^\s*lit-part\b/, 'Lit marker'],
  [/^\s*\/?\$[!?]?\s*$|^\s*[[\]]\s*$|^\s*(?:teleport|v-if)\b/, 'hydration marker'],
  [/^\s*\/?noindex\s*$/i, 'indexing directive'],
  [/^\s*\/?wp:/, 'WordPress block delimiter'],
  [/^\s*(?:Instance|Template)(?:Begin|End)\b|^\s*#(?:Begin|End)(?:Library|Template)/, 'template editor region']
];

const OPTIONS_ATTRIBUTES = new Set(['collapseAttributeWhitespace', 'collapseBooleanAttributes', 'removeDefaultTypeAttributes', 'removeEmptyAttributes', 'removeRedundantAttributes', 'sortClassNames']);
const OPTIONS_WHITESPACE = new Set(['collapseInlineTagWhitespace', 'collapseNoBreakSpaces', 'collapseWhitespace', 'trimCustomFragments']);

/** @param {string} text */
const clip = (text, length = 60) => text.length > length ? `${text.slice(0, length - 1)}…` : text;

/**
 * @param {Node} node
 * @param {(node: Node) => void} visit
 */
function walk(node, visit) {
  visit(node);
  const content = /** @type {{content?: Node}} */ (node).content;
  for (const child of [...('childNodes' in node ? node.childNodes : []), ...(content ? [content] : [])]) {
    walk(/** @type {Node} */ (child), visit);
  }
}

/** @param {string} html */
function elementsOf(html) {
  /** @type {Element[]} */
  const elements = [];
  walk(parse(html), (node) => {
    if ('tagName' in node) elements.push(node);
  });
  return elements;
}

/**
 * @param {Element} element
 * @param {string} name
 */
const attr = (element, name) => element.attrs.find((item) => item.name === name)?.value;

/** @param {Element} element */
const textOf = (element) => element.childNodes.map((child) => 'value' in child ? child.value : '').join('');

/**
 * Keys counted more often in `before` than in `after`
 * @param {string[]} before
 * @param {string[]} after
 */
function removed(before, after) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const key of before) counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const key of after) counts.set(key, (counts.get(key) ?? 0) - 1);
  return [...counts].filter(([, count]) => count > 0).map(([key]) => key);
}

/**
 * A selector without what parentheses and quotes hold, however nested, in linear time;
 * escaped characters don’t count
 * @param {string} selector
 */
function outlineOf(selector) {
  let depth = 0;
  let kept = '';
  /** @type {string | null} */
  let quote = null;
  for (let index = 0; index < selector.length; index++) {
    const char = selector[index] ?? '';
    if (char === '\\') {
      const escape = char + (selector[++index] ?? '');
      if (!depth && !quote) kept += escape;
    } else if (quote) {
      if (char !== quote) continue;
      quote = null;
      if (!depth) kept += char;
    } else if (char === '(') {
      depth++;
    } else if (char === ')' && depth) {
      depth--;
    } else {
      if (char === '"' || char === '\'') quote = char;
      if (!depth) kept += char;
    }
  }
  return kept;
}

// Escapes, attribute selectors, pseudo-classes, CSS whitespace, combinators, commas, and the rest
const RE_SELECTOR_TOKEN = /\\(?:[0-9a-f]{1,6}[ \t\n\f\r]?|[^0-9a-f])|\[[^\]]*\]?|::?[\w-]+|[ \t\n\f\r]+|[>+~,]|[^ \t\n\f\r>+~,\\:[]+|:/gi;
const RE_SELECTOR_ATTRIBUTE = /\[[^\]]*\]?/g;
const RE_SELECTOR_NAME = /([.#])((?:\\(?:[0-9a-f]{1,6}[ \t\n\f\r]?|[^0-9a-f])|[\w\u00A0-\uFFFF-])+)/gi;

/**
 * The last compound of each selector in a list, without pseudo-classes
 * @param {string} selector
 */
function compoundsOf(selector) {
  /** @type {string[]} */
  const compounds = [];
  let compound = '';
  // Whitespace combines only where another compound follows
  let isDescending = false;
  for (const [token] of outlineOf(selector).matchAll(RE_SELECTOR_TOKEN)) {
    if (token === ',') {
      compounds.push(compound);
      compound = '';
      isDescending = false;
    } else if (/^[ \t\n\f\r]/.test(token)) {
      isDescending = true;
    } else if (/^[>+~]$/.test(token)) {
      compound = '';
      isDescending = false;
    } else {
      if (isDescending) compound = '';
      isDescending = false;
      if (!token.startsWith(':')) compound += token;
    }
  }
  compounds.push(compound);
  return compounds;
}

/** @param {string} name */
const unescapeCss = (name) => name.replace(/\\(?:([0-9a-f]{1,6})[ \t\n\f\r]?|([\s\S]))/gi, (_, hex, char) => {
  if (!hex) return char;
  const code = parseInt(hex, 16);
  return code && code <= 0x10FFFF ? String.fromCodePoint(code) : '\uFFFD';
});

/**
 * Whether any element may match a selector, judged by the tag, classes, IDs, and attributes
 * of the last compound of each selector in the list—erring toward a match
 * @param {string} selector
 * @param {Element[]} elements
 */
function mayMatch(selector, elements) {
  return compoundsOf(selector).some((compound) => {
    const tag = compound.match(/^[a-z][\w-]*/i)?.[0].toLowerCase();
    const names = [...compound.replace(RE_SELECTOR_ATTRIBUTE, '').matchAll(RE_SELECTOR_NAME)].map((match) => ({ isClass: match[1] === '.', name: unescapeCss(match[2] ?? '') }));
    const classes = names.filter(({ isClass }) => isClass).map(({ name }) => name);
    const ids = names.filter(({ isClass }) => !isClass).map(({ name }) => name);
    const attributes = [...compound.matchAll(/\[\s*([\w-]+)/g)].map((match) => (match[1] ?? '').toLowerCase());
    return elements.some((element) => {
      const own = (attr(element, 'class') ?? '').split(/\s+/);
      return (!tag || element.tagName === tag) &&
        classes.every((name) => own.includes(name)) &&
        ids.every((id) => attr(element, 'id') === id) &&
        attributes.every((name) => element.attrs.some((item) => item.name === name));
    });
  });
}

/** @param {string} css */
function whitespaceRulesOf(css) {
  /** @type {{selector: string, text: string}[]} */
  const rules = [];
  // Without comments and statements like `@import`, which would otherwise lead the next selector
  for (const match of css.replace(RE_CSS_COMMENT, '').replace(RE_CSS_STATEMENT, '').matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const selector = (match[1] ?? '').trim();
    const declaration = (match[2] ?? '').match(RE_WHITESPACE_KEPT)?.[0];
    if (!declaration || selector.startsWith('@')) continue;
    if (selector.split(',').every((part) => SELECTORS_PREFORMATTED.has(part.trim().toLowerCase()))) continue;
    rules.push({ selector, text: `${clip(selector, 40)} { ${declaration} }` });
  }
  return rules;
}

/** @param {string} css */
const selectorTokens = (css) => {
  let selectors = css.replace(RE_CSS_COMMENT, '');
  // Strips declaration blocks innermost first, so that nested at-rules leave their selectors
  for (let previous = ''; previous !== selectors;) {
    previous = selectors;
    selectors = selectors.replace(/\{[^{}]*\}/g, ',');
  }
  return [...selectors.matchAll(/[.#](-?[_a-zA-Z\u00A0-\uFFFF][\w\u00A0-\uFFFF-]*)/g)].map((match) => `${match[0][0]}${match[1]}`);
};

/**
 * Collects what a page’s scripts and style sheets reference
 * @param {import('./pages.js').Page} page
 * @returns {Promise<PageContext>}
 */
export async function analyzePage(page) {
  /** @type {string[]} */
  const scripts = [];
  /** @type {string[]} */
  const scriptsUnread = [];
  /** @type {string[]} */
  const styles = [];
  /** @type {Promise<void>[]} */
  const pending = [];
  /** @type {Set<string>} */
  const imported = new Set();

  /**
   * Adds a style sheet and, where local or same-origin, what it imports
   * @param {string} css
   * @param {string | null} base Reference of the style sheet, if not in the page
   */
  const addStyles = (css, base) => {
    styles.push(css);
    for (const [, , ref = ''] of css.replace(RE_CSS_COMMENT, '').matchAll(RE_IMPORT)) {
      let target;
      try {
        target = base === null ? ref : page.resolve(ref, base);
      } catch {
        continue;
      }
      if (imported.has(target)) continue;
      imported.add(target);
      pending.push(page.load(target).then((sheet) => { if (sheet) addStyles(sheet.text, sheet.ref); }));
    }
  };

  for (const element of elementsOf(page.html)) {
    for (const { name, value } of element.attrs) {
      if (/^on[a-z]{3,}$/.test(name)) scripts.push(value);
      if (name === 'style') styles.push(`[style]{${value}}`);
    }
    if (element.tagName === 'script' && RE_SCRIPT_JS.test((attr(element, 'type') ?? '').trim())) {
      const src = attr(element, 'src');
      if (src === undefined) {
        scripts.push(textOf(element));
      } else {
        pending.push(page.load(src).then((script) => { script === null ? scriptsUnread.push(src) : scripts.push(script.text); }));
      }
    } else if (element.tagName === 'style') {
      addStyles(textOf(element), null);
    } else if (element.tagName === 'link' && /(?:^|\s)stylesheet(?:\s|$)/i.test(attr(element, 'rel') ?? '')) {
      const href = attr(element, 'href');
      if (href) pending.push(page.load(href).then((sheet) => { if (sheet) addStyles(sheet.text, sheet.ref); }));
    }
  }
  // Imports add to what is pending while it settles
  while (pending.length) await Promise.all(pending.splice(0));

  const scriptText = scripts.join('\n;\n');
  const css = styles.join('\n');
  /** @type {Set<string>} */
  const scriptStrings = new Set();
  /** @type {Set<string>} */
  const attributeRefs = new Set();
  for (const literal of scriptText.matchAll(RE_STRING_LITERAL)) {
    const content = literal[2] ?? '';
    for (const word of content.match(RE_WORD) ?? []) scriptStrings.add(word);
    for (const match of content.matchAll(RE_ATTRIBUTE_SELECTOR)) attributeRefs.add((match[1] ?? '').toLowerCase());
  }
  for (const match of scriptText.matchAll(RE_ATTRIBUTE_CALL)) attributeRefs.add((match[1] ?? '').toLowerCase());
  for (const match of css.matchAll(RE_ATTRIBUTE_SELECTOR)) attributeRefs.add((match[1] ?? '').toLowerCase());

  return { scriptStrings, scriptText, scriptsUnread: scriptsUnread.sort(), attributeRefs, whitespaceRules: whitespaceRulesOf(css) };
}

/**
 * What may break when an option turns `before` into `after`
 * @param {string} name Candidate name
 * @param {PageContext} context
 * @param {string} before Output without the option
 * @param {string} after Output with the option
 * @returns {Hazard[]}
 */
export function findHazards(name, context, before, after) {
  if (before === after) return [];
  /** @type {Hazard[]} */
  const hazards = [];

  if (OPTIONS_WHITESPACE.has(name) && context.whitespaceRules.length) {
    const elements = elementsOf(before);
    const applying = context.whitespaceRules.filter((rule) => mayMatch(rule.selector, elements));
    if (applying.length) {
      hazards.push({ level: 'check', message: `Collapses whitespace that CSS keeps (${applying.slice(0, 2).map((rule) => rule.text).join('; ')})` });
    }
  }

  if (name === 'removeComments') {
    /** @param {string} html */
    const comments = (html) => {
      /** @type {string[]} */
      const data = [];
      walk(parse(html), (node) => { if (node.nodeName === '#comment' && 'data' in node) data.push(node.data); });
      return data;
    };
    const gone = removed(comments(before), comments(after));
    /** @type {Map<string, number>} */
    const perLabel = new Map();
    for (const data of gone) {
      const conditional = RE_COMMENT_CONDITIONAL.test(data);
      const label = conditional ? 'conditional comment' : COMMENTS_MEANINGFUL.find(([re]) => re.test(data))?.[1];
      if (!label || (perLabel.get(label) ?? 0) >= MAX_PER_KIND) continue;
      perLabel.set(label, (perLabel.get(label) ?? 0) + 1);
      hazards.push(conditional
        ? { level: 'note', message: `Removes a conditional comment, which only Internet Explorer 9 and older read: <!--${clip(data, 40)}-->` }
        : { level: 'risk', message: `Removes a comment that looks meaningful (${label}): <!--${clip(data, 40)}-->` });
    }
    if (gone.length && RE_READS_COMMENTS.test(context.scriptText)) {
      hazards.push({ level: 'risk', message: 'Removes comments, and scripts read comments' });
    }
  }

  if (name === 'removeEmptyElements') {
    /** @param {string} html */
    const signatures = (html) => elementsOf(html).map((element) => JSON.stringify([element.tagName, attr(element, 'id') ?? '', attr(element, 'class') ?? '']));
    const gone = removed(signatures(before), signatures(after));
    let count = 0;
    for (const signature of gone) {
      const [tag, id, classes] = /** @type {[string, string, string]} */ (JSON.parse(signature));
      const named = [id, ...classes.split(/\s+/)].filter((token) => token && context.scriptStrings.has(token));
      if (named.length && count++ < MAX_PER_KIND) {
        const shown = `<${tag}${id ? ` id="${id}"` : ''}${classes ? ` class="${clip(classes, 30)}"` : ''}>`;
        hazards.push({ level: 'risk', message: `Removes empty ${shown}, which scripts may fill (${named.map((token) => `\`${token}\``).join(', ')})` });
      }
    }
    if (gone.length && context.scriptsUnread.length) {
      hazards.push({ level: 'note', message: `Removes empty elements that unread scripts may fill (${clip(context.scriptsUnread.join(', '))})` });
    }
  }

  if (name === 'removeUnusedCSS') {
    /** @param {string} html */
    const tokens = (html) => [...new Set(elementsOf(html).filter((element) => element.tagName === 'style').flatMap((element) => selectorTokens(textOf(element))))];
    const gone = removed(tokens(before), tokens(after));
    const named = gone.filter((token) => context.scriptStrings.has(token.slice(1)));
    if (named.length) {
      hazards.push({ level: 'risk', message: `Removes rules for ${named.slice(0, MAX_PER_KIND).map((token) => `\`${token}\``).join(', ')}, which scripts name and may add` });
    }
    if (gone.length && context.scriptsUnread.length) {
      hazards.push({ level: 'note', message: `Removes rules that unread scripts may need (${clip(context.scriptsUnread.join(', '))})` });
    }
  }

  if (OPTIONS_ATTRIBUTES.has(name)) {
    /** @param {string} html */
    const attributes = (html) => elementsOf(html).flatMap((element) => element.attrs.map(({ name: attrName, value }) => JSON.stringify([attrName, value])));
    const changed = new Set(removed(attributes(before), attributes(after)).map((key) => /** @type {string} */ (JSON.parse(key)[0])));
    const referenced = [...changed].filter((attrName) => context.attributeRefs.has(attrName)).sort();
    if (referenced.length) {
      hazards.push({ level: 'risk', message: `Changes ${referenced.map((attrName) => `\`${attrName}\``).join(', ')} attributes, which style sheets or scripts select on` });
    }
  }

  if (name === 'useShortDoctype') {
    const [modeBefore = '', modeAfter = ''] = [before, after].map((html) => String(parse(html).mode));
    if (modeBefore !== modeAfter) {
      hazards.push({ level: 'check', message: `Switches the page from ${MODES[modeBefore] ?? modeBefore} to ${MODES[modeAfter] ?? modeAfter}, which can change layout` });
    }
  }

  if (name === 'mergeScripts' && /\bcurrentScript\b/.test(context.scriptText)) {
    hazards.push({ level: 'check', message: 'Scripts use `document.currentScript`, which merging changes' });
  }

  return hazards;
}