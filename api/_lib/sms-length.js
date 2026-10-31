/**
 * Keeping texts to one segment (asked for 2026-10-31: one segment the
 * default, two only when necessary).
 *
 * A text is billed by segments. In the plain GSM-7 alphabet one segment holds
 * 160 characters, and a longer text is split into 153-character parts. A
 * single character outside it (a curly apostrophe, most accented letters, a
 * long dash, an emoji) sends the whole text as UCS-2 instead, at 70 and 67:
 * one "’" from the model, or a client called "José", could treble the cost.
 * So every text is put into GSM-7 before it goes (toGsm), and each
 * appointment text picks its longest wording that still fits one segment
 * (fitText).
 */

// The GSM 03.38 basic set, and the extension set (each of those costs two).
const BASIC = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
);
const EXTENDED = new Set('^{}\\[~]|€');

/** Common look-alikes, to their plain GSM forms. */
const SWAP = new Map([
  ['‘', "'"], ['’', "'"], ['‚', "'"], ['‛', "'"], ['`', "'"], ['´', "'"],
  ['“', '"'], ['”', '"'], ['„', '"'],
  ['–', '-'], ['—', '-'], ['‒', '-'], ['−', '-'],
  ['…', '...'], ['•', '-'], ['·', '-'],
  [' ', ' '], [' ', ' '], [' ', ' '], ['\t', ' '],
]);

/**
 * The text in GSM-7: look-alikes swapped, accents the alphabet lacks taken
 * off ("José" stays as it is, since é is in it; "Zoë" becomes "Zoe"), and
 * anything with no plain form (an emoji) left out.
 */
export function toGsm(text) {
  let out = '';
  for (const ch of String(text ?? '')) {
    if (BASIC.has(ch) || EXTENDED.has(ch)) { out += ch; continue; }
    if (SWAP.has(ch)) { out += SWAP.get(ch); continue; }
    const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (base && [...base].every((c) => BASIC.has(c))) out += base;
  }
  return out.replace(/ {2,}/g, ' ');
}

/** How many segments a text costs as it would be sent. */
export function segments(text) {
  const t = String(text ?? '');
  const gsm = [...t].every((c) => BASIC.has(c) || EXTENDED.has(c));
  if (gsm) {
    const units = [...t].reduce((n, c) => n + (EXTENDED.has(c) ? 2 : 1), 0);
    return units <= 160 ? 1 : Math.ceil(units / 153);
  }
  const units = [...t].length;
  return units <= 70 ? 1 : Math.ceil(units / 67);
}

/**
 * The longest of `versions` (fullest first) that fits one segment; failing
 * that, the fullest that fits two; failing that, the shortest. Each is put
 * into GSM-7 first.
 */
export function fitText(versions) {
  const ready = versions.filter(Boolean).map(toGsm);
  return ready.find((t) => segments(t) === 1)
    || ready.find((t) => segments(t) <= 2)
    || ready[ready.length - 1];
}
