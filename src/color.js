// Terminal styles from the terminal’s own palette, which themes adapt to light and dark: standard
// colors, bold, and dim only—never fixed black, white, or 256-color values

export const ESC = '\u001b';
export const CSI = `${ESC}[`;

const STYLES = { bold: '1', dim: '2', accent: '36', success: '32', warning: '33', failure: '31' };

/**
 * @param {keyof typeof STYLES} name
 * @param {string} text
 * @param {boolean} color
 */
export const paint = (name, text, color) => color && text ? `${CSI}${STYLES[name]}m${text}${CSI}0m` : text;

/** @param {{isTTY?: boolean}} stream */
export const supportsColor = (stream) => Boolean(stream.isTTY) && !process.env.NO_COLOR && process.env.TERM !== 'dumb';