/**
 * Small helpers shared by every endpoint: JSON replies, method routing and
 * the input validation that keeps bad data out of the diary.
 */
import { randomInt, timingSafeEqual } from 'node:crypto';

import { REF_ALPHABET, REF_LENGTH } from './config.js';

export function json(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  // Availability changes the moment anyone books, so nothing here is cacheable.
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

/** A failure the caller caused and can act on, as opposed to a bug. */
export class HttpError extends Error {
  constructor(status, message, code = undefined) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Wrap a handler so thrown HttpErrors become clean replies and anything else
 * becomes a 500 without leaking a stack trace to the guest.
 */
export function handler(methods) {
  return async (req, res) => {
    const fn = methods[req.method];
    if (!fn) {
      res.setHeader('Allow', Object.keys(methods).join(', '));
      return json(res, 405, { error: 'Method not allowed' });
    }
    try {
      return await fn(req, res);
    } catch (err) {
      if (err instanceof HttpError) {
        return json(res, err.status, { error: err.message, code: err.code });
      }
      console.error('unhandled error', err);
      return json(res, 500, { error: 'Something went wrong on our end.' });
    }
  };
}

export async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.');
  }
}

// ------------------------------------------------------------- validation

export function requireString(value, field, { max = 200, min = 1 } = {}) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (s.length < min) throw new HttpError(400, `${field} is required.`);
  if (s.length > max) throw new HttpError(400, `${field} is too long.`);
  return s;
}

/**
 * Deliberately permissive. The confirmation email is the real test of an
 * address, and a clever regex mostly rejects valid addresses people own.
 */
export function requireEmail(value, field = 'Email') {
  const s = requireString(value, field, { max: 254 });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) {
    throw new HttpError(400, `${field} does not look like an email address.`);
  }
  return s.toLowerCase();
}

/** Optional, because a guest who gives an email has given us enough. */
export function optionalPhone(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) return '';
  if (s.replace(/\D/g, '').length < 7) {
    throw new HttpError(400, 'That phone number looks too short.');
  }
  return s.slice(0, 40);
}

export function requireId(value, field) {
  const s = requireString(value, field, { max: 64 });
  if (!/^[a-z0-9-]+$/.test(s)) throw new HttpError(400, `${field} is not valid.`);
  return s;
}

/** YYYY-MM-DD, checked for shape here and for reality by Luxon downstream. */
export function requireDate(value, field) {
  const s = requireString(value, field, { max: 10 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new HttpError(400, `${field} must be a date like 2026-10-01.`);
  }
  return s;
}

// ------------------------------------------------------------------ tokens

export function newRef() {
  let out = '';
  for (let i = 0; i < REF_LENGTH; i += 1) {
    out += REF_ALPHABET[randomInt(REF_ALPHABET.length)];
  }
  return out;
}

export function newToken() {
  let out = '';
  for (let i = 0; i < 32; i += 1) {
    out += REF_ALPHABET[randomInt(REF_ALPHABET.length)];
  }
  return out.toLowerCase();
}

/**
 * Compare a supplied manage-token against the stored one without leaking how
 * much of it matched through response timing.
 */
export function tokenMatches(supplied, stored) {
  if (typeof supplied !== 'string' || typeof stored !== 'string') return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(stored);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
