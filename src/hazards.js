// What a page’s own scripts and style sheets rely on that an option may change—found by comparing
// output with and without the option, and matching what changed against what the page references

import { transform, transformStyleAttribute } from 'lightningcss';
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
 * @prop {(CssRule & {text: string})[]} whitespaceRules Rules that keep whitespace, outside `pre` and `textarea`
 */

/**
 * A style rule, with its selector as written and, if nested, its parent
 * @typedef {{selectors: Selector[], parent: CssRule | null, declarations: Declaration[], selector: string}} CssRule
 */

/** @typedef {import('lightningcss').Declaration} Declaration */
/** @typedef {import('lightningcss').Rule} Rule */
/** @typedef {import('lightningcss').Selector} Selector */
/** @typedef {import('lightningcss').SelectorComponent} SelectorComponent */
/** @typedef {import('parse5').DefaultTreeAdapterMap['node']} Node */
/** @typedef {import('parse5').DefaultTreeAdapterMap['element']} Element */

const MAX_PER_KIND = 3;

/** @type {Record<string, string>} */
const MODES = { 'quirks': 'quirks mode', 'limited-quirks': 'almost standards mode', 'no-quirks': 'standards mode' };
const RE_STRING_LITERAL = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
const RE_WORD = /[\w-]+/g;
// What separates classes in HTML, unlike JavaScript’s `\s`, which includes no-break spaces
const RE_WHITESPACE_ASCII = /[ \t\n\f\r]+/;
const RE_ESCAPE_JS = /\\(?:u\{([\da-f]+)\}|u([\da-f]{4})|x([\da-f]{2})|([\s\S]))/gi;
/** @type {Record<string, string>} */
const ESCAPES_JS = { 'b': '\b', 'f': '\f', 'n': '\n', 'r': '\r', 't': '\t', 'v': '\v', '0': '\0' };
const RE_ATTRIBUTE_SELECTOR = /\[\s*([\w-]+)\s*(?=[~|^$*]?=|\])/g;
const RE_ATTRIBUTE_CALL = /\b(?:get|has|remove|set|toggle)Attribute(?:NS)?\(\s*(?:[^,()]*,\s*)?["'`]([\w-]+)/g;
const RE_READS_COMMENTS = /SHOW_COMMENT|COMMENT_NODE|nodeType\s*[!=]==?\s*8\b|\.childNodes\b[^;]*\.data\b/;
const RE_SCRIPT_JS = /^(?:|module|(?:application|text)\/(?:x-)?(?:java|ecma)script|text\/javascript1\.[0-5]|text\/jscript|text\/livescript)$/i;
const KEYWORDS_WHITESPACE_KEPT = new Set(['break-spaces', 'pre', 'pre-line', 'pre-wrap', 'preserve', 'preserve-breaks', 'preserve-spaces']);
const PROPERTIES_WHITESPACE = new Set(['white-space', 'white-space-collapse']);
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
 * Text of a JavaScript string literal, with escapes decoded
 * @param {string} text
 */
const unescapeJs = (text) => text.replace(RE_ESCAPE_JS, (_, braced, unicode, hex, char) => {
  if (char !== undefined) return ESCAPES_JS[char] ?? char;
  const code = parseInt(braced ?? unicode ?? hex, 16);
  return code <= 0x10FFFF ? String.fromCodePoint(code) : '\uFFFD';
});

/**
 * Components of selectors, including those in arguments like `:is()`, however deeply nested
 * @param {unknown} value
 */
function componentsOf(value) {
  /** @type {{type?: unknown, name?: unknown}[]} */
  const components = [];
  for (const stack = [value]; stack.length;) {
    const item = stack.pop();
    if (!item || typeof item !== 'object') continue;
    if (!Array.isArray(item) && 'type' in item) components.push(item);
    stack.push(...Object.values(item).reverse());
  }
  return components;
}

/**
 * Names of the classes (`.name`), IDs (`#name`), and attributes (`[name]`) rules select on
 * @param {CssRule[]} rules
 */
const namesOf = (rules) => rules.flatMap((rule) => componentsOf(rule.selectors).flatMap(({ type, name }) => {
  const prefix = { class: '.', id: '#', attribute: '[' }[String(type)];
  return prefix && typeof name === 'string' ? [prefix + name] : [];
}));

/**
 * A declaration that keeps whitespace, as text
 * @param {Declaration} declaration
 */
function keepingWhitespace(declaration) {
  const [name, values] = declaration.property === 'custom' ? [declaration.value.name, declaration.value.value]
    : declaration.property === 'unparsed' ? [declaration.value.propertyId.property, declaration.value.value]
    : [declaration.property, [declaration.value]];
  if (!PROPERTIES_WHITESPACE.has(name.toLowerCase())) return;
  const keywords = /** @type {unknown[]} */ (values).flatMap((value) => {
    if (typeof value === 'string') return value.split(' ');
    const token = /** @type {{type?: unknown, value?: {type?: unknown, value?: unknown}}} */ (value);
    return token.type === 'token' && token.value?.type === 'ident' ? [String(token.value.value)] : [];
  }).map((keyword) => keyword.toLowerCase());
  return keywords.some((keyword) => KEYWORDS_WHITESPACE_KEPT.has(keyword)) ? `${name.toLowerCase()}: ${keywords.join(' ')}` : undefined;
}

/**
 * Style rules of a style sheet, including nested ones, and what it imports; as in browsers,
 * invalid rules are dropped
 * @param {string} css
 */
function readStyles(css) {
  /** @type {CssRule[]} */
  const rules = [];
  /** @type {string[]} */
  const imports = [];
  const lineStarts = [0, ...[...css.matchAll(/\r\n|[\n\r\f]/g)].map((match) => match.index + match[0].length)];
  /** @param {{line: number, column: number}} loc */
  const selectorAt = ({ line, column }) => {
    const offset = (lineStarts[line] ?? 0) + column - 1;
    const end = css.indexOf('{', offset);
    return css.slice(offset, end < 0 ? undefined : end).trim();
  };
  /**
   * @param {Rule[]} children
   * @param {CssRule | null} parent
   */
  const collect = (children, parent) => {
    for (const child of children) {
      if (child.type === 'import') {
        imports.push(child.value.url);
      } else if (child.type === 'style') {
        const { declarations = [], importantDeclarations = [] } = child.value.declarations ?? {};
        const rule = { selectors: child.value.selectors, parent, declarations: [...declarations, ...importantDeclarations], selector: selectorAt(child.value.loc) };
        rules.push(rule);
        collect(child.value.rules ?? [], rule);
      } else if (child.type === 'scope') {
        // `&` in a scope stands for its root, which, without a selector, may be any element
        const { scopeStart, scopeEnd, rules: scoped, loc } = child.value;
        const scope = { selectors: scopeStart ?? [[]], parent, declarations: [], selector: selectorAt(loc) };
        rules.push(scope);
        if (scopeEnd) rules.push({ ...scope, selectors: scopeEnd, parent: scope });
        collect(scoped, scope);
      } else if (child.type === 'nested-declarations' && parent) {
        const { declarations = [], importantDeclarations = [] } = child.value.declarations ?? {};
        rules.push({ ...parent, selectors: [[{ type: 'nesting' }]], parent, declarations: [...declarations, ...importantDeclarations] });
      } else if ('value' in child && child.value && 'rules' in child.value && Array.isArray(child.value.rules)) {
        collect(/** @type {Rule[]} */ (child.value.rules), parent);
      }
    }
  };
  try {
    transform({ filename: 'style.css', code: Buffer.from(css), errorRecovery: true, visitor: { StyleSheet: (sheet) => collect(sheet.rules, null) } });
  } catch {
    // Errors aren’t recovered from in every case, and a style sheet that can’t be read has no rules
  }
  return { rules, imports };
}

/**
 * Rules that some element may match, judged by the tag, classes, IDs, and attributes of the last
 * compound of each selector—erring toward a match
 * @template {CssRule} T
 * @param {T[]} rules
 * @param {Element[]} elements
 */
function rulesMatching(rules, elements) {
  /** @type {Map<CssRule, Set<Element>>} */
  const matched = new Map();
  /**
   * @param {CssRule} rule
   * @returns {Set<Element>}
   */
  const matching = (rule) => {
    const known = matched.get(rule);
    if (known) return known;
    const compounds = rule.selectors.map((selector) => selector.slice(selector.findLastIndex((component) => component.type === 'combinator') + 1));
    /**
     * @param {SelectorComponent} component
     * @param {Element} element
     */
    const fits = (component, element) => {
      switch (component.type) {
        case 'type': return element.tagName.toLowerCase() === component.name.toLowerCase();
        case 'class': return (attr(element, 'class') ?? '').split(RE_WHITESPACE_ASCII).includes(component.name);
        case 'id': return attr(element, 'id') === component.name;
        case 'attribute': return element.attrs.some((item) => item.name === component.name.toLowerCase());
        case 'nesting': return !rule.parent || matching(rule.parent).has(element);
        default: return true;
      }
    };
    const found = new Set(elements.filter((element) => compounds.some((compound) => compound.every((component) => fits(component, element)))));
    matched.set(rule, found);
    return found;
  };
  return rules.filter((rule) => matching(rule).size);
}

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
  /** @type {CssRule[]} */
  const rules = [];
  /** @type {Set<string>} */
  const attributeRefs = new Set();
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
    const styles = readStyles(css);
    rules.push(...styles.rules);
    for (const name of namesOf(styles.rules)) if (name.startsWith('[')) attributeRefs.add(name.slice(1).toLowerCase());
    for (const ref of styles.imports) {
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
      if (name === 'style') {
        /** @type {Declaration[]} */
        const declarations = [];
        try {
          transformStyleAttribute({ code: Buffer.from(value), errorRecovery: true, visitor: { Declaration: (declaration) => { declarations.push(declaration); } } });
        } catch {
          // As with style sheets
        }
        rules.push({ selectors: [[{ type: 'attribute', name: 'style', namespace: null, operation: null }]], parent: null, declarations, selector: '[style]' });
      }
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
  /** @type {Set<string>} */
  const scriptStrings = new Set();
  for (const literal of scriptText.matchAll(RE_STRING_LITERAL)) {
    const content = literal[2] ?? '';
    // Words, and what whitespace separates, for names like `md:open`
    for (const word of [...content.match(RE_WORD) ?? [], ...content.split(RE_WHITESPACE_ASCII)]) if (word) scriptStrings.add(word);
    // Names in selectors, as in `querySelector('.md\\:open')`, decoded as in style sheets
    if (content.includes('\\')) {
      for (const name of namesOf(readStyles(`${unescapeJs(content)}{}`).rules)) if (!name.startsWith('[')) scriptStrings.add(name.slice(1));
    }
    for (const match of content.matchAll(RE_ATTRIBUTE_SELECTOR)) attributeRefs.add((match[1] ?? '').toLowerCase());
  }
  for (const match of scriptText.matchAll(RE_ATTRIBUTE_CALL)) attributeRefs.add((match[1] ?? '').toLowerCase());

  /** @type {(CssRule & {text: string})[]} */
  const whitespaceRules = [];
  for (const rule of rules) {
    const kept = rule.declarations.map(keepingWhitespace).find(Boolean);
    if (!kept || rule.selectors.every(([component, ...rest]) => !rest.length && component?.type === 'type' && SELECTORS_PREFORMATTED.has(component.name.toLowerCase()))) continue;
    whitespaceRules.push({ ...rule, text: `${clip(rule.selector, 40)} { ${kept} }` });
  }

  return { scriptStrings, scriptText, scriptsUnread: scriptsUnread.sort(), attributeRefs, whitespaceRules };
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
    const applying = rulesMatching(context.whitespaceRules, elements);
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
      const named = [id, ...classes.split(RE_WHITESPACE_ASCII)].filter((token) => token && context.scriptStrings.has(token));
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
    const tokens = (html) => [...new Set(elementsOf(html).filter((element) => element.tagName === 'style').flatMap((element) => namesOf(readStyles(textOf(element)).rules).filter((token) => !token.startsWith('['))))];
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