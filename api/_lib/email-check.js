/**
 * Is this an email address that can receive mail? One check for every path
 * that takes a guest's address (asked for 2026-11-12): the website survey
 * (enquiry.js), the public booking (book.js through requireEmail) and the
 * front desk (staff book.js).
 *
 * The old test was only the shape name@domain.tld, so a Nov 2 test booking to
 * "...@gmail.conm" was taken, "sent", and never arrived. The shape is still
 * deliberately permissive (a clever pattern mostly rejects addresses people
 * really own); what is new is that the ending must be one that exists (IANA's
 * list, tlds.js), and the big providers' usual slips are named. Neither can
 * refuse a working address: no mail goes to an ending that does not exist,
 * and the slips below are not domains anybody receives mail at.
 */
import { TLDS } from './tlds.js';

/** Endings people mean when they mistype one, nearest first on a tie. */
const COMMON_ENDINGS = ['com', 'net', 'org', 'edu', 'gov', 'us', 'co', 'io', 'info', 'biz', 'me', 'ca', 'uk'];

/**
 * Domains that are slips for a big provider. A list rather than "close to
 * gmail.com", because close is not wrong: mail.com and ymail.com are real.
 * gmail.co, .cm and .om end in real country endings, so the ending check
 * alone lets them through.
 */
const SLIPS = {
  // The big providers on the country endings a slip lands on: Colombia (.co),
  // Cameroon (.cm) and Oman (.om) are real, so the ending check lets them by
  // (yahoo.cm and friends got through until QC found them, 2026-11-12).
  ...Object.fromEntries(['gmail', 'yahoo', 'hotmail', 'outlook', 'icloud', 'aol']
    .flatMap((p) => ['co', 'cm', 'om'].map((e) => [`${p}.${e}`, `${p}.com`]))),
  'gmial.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gmal.com': 'gmail.com', 'gamil.com': 'gmail.com',
  'gnail.com': 'gmail.com', 'gmaill.com': 'gmail.com', 'gmaul.com': 'gmail.com', 'gmeil.com': 'gmail.com',
  'gmil.com': 'gmail.com', 'gmali.com': 'gmail.com',
  'yaho.com': 'yahoo.com', 'yahooo.com': 'yahoo.com', 'yhoo.com': 'yahoo.com', 'yahho.com': 'yahoo.com',
  'tahoo.com': 'yahoo.com',
  'hotmial.com': 'hotmail.com', 'hotmal.com': 'hotmail.com', 'hotmai.com': 'hotmail.com', 'hotmil.com': 'hotmail.com',
  'hotmaill.com': 'hotmail.com', 'hotnail.com': 'hotmail.com',
  'outlok.com': 'outlook.com', 'outllok.com': 'outlook.com', 'outloo.com': 'outlook.com',
  'iclod.com': 'icloud.com', 'icoud.com': 'icloud.com', 'icluod.com': 'icloud.com',
};

/** Edits between two short strings, a swap of neighbours counting as one ("cmo" for "com"). */
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) d[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Null when the address can receive mail as far as we can tell without
 * sending, else one sentence saying what is wrong, with the likely address
 * when there is one. Case and surrounding spaces do not matter.
 */
export function emailProblem(value) {
  const s = String(value ?? '').trim().toLowerCase();
  if (!s) return 'Please add an email address.';
  const at = s.lastIndexOf('@');
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  const labels = domain.split('.');
  if (at < 1 || s.length > 254 || /\s/.test(s) || local.includes('@')
      || labels.length < 2 || !labels.every((l) => LABEL.test(l))) {
    return `"${s}" is not a complete email address.`;
  }
  const ending = labels[labels.length - 1];
  if (!TLDS.has(ending)) {
    const near = COMMON_ENDINGS
      .map((e) => [e, distance(ending, e)])
      .filter(([, n]) => n <= 2)
      .sort((x, y) => x[1] - y[1])[0];
    const rest = labels.slice(0, -1).join('.');
    return `"${s}" doesn't look right: ".${ending}" is not an email ending.`
      + (near ? ` Did you mean ${local}@${rest}.${near[0]}?` : '');
  }
  if (SLIPS[domain]) return `"${s}" doesn't look right. Did you mean ${local}@${SLIPS[domain]}?`;
  return null;
}
