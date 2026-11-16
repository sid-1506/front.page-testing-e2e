/**
 * Redaction. Everything that is stored or shown (URLs, headers, payloads, response previews,
 * console text, error messages, DOM selectors) goes through here before it touches disk.
 *
 * Three layers:
 *  1. key-based: object keys / query params / header names matching SECRET_KEY_RE get their value replaced
 *  2. pattern-based: JWTs, Bearer tokens, "key":"value" pairs inside raw (non-JSON) text
 *  3. literal: exact secret strings we know about (TEST_PASSWORD, TEST_EMAIL, REDACT_TERMS, every cookie /
 *     storage value in playwright/.auth/user.json, the logged-in user's name/handle) are replaced wherever they occur
 */
import fs from 'node:fs';
import path from 'node:path';

export const SECRET_KEY_RE = /pass(word)?|token|secret|auth|session|cookie|api[-_]?key|card|cvv|cvc|ssn|otp/i;
/** Not secrets in the strict sense, but personal data of the test account: scrubbed as well. */
export const PII_KEY_RE = /^(phone|phone_?number|mobile|mobile_?number|msisdn|email|e_?mail|user_?email)$/i;
export const SECRET_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'proxy-authorization', 'x-csrf-token', 'x-xsrf-token']);

export const REDACTED = '[REDACTED]';
export const USER_PLACEHOLDER = '[test-user]';

const AUTH_DIR = path.join(__dirname, '..', 'playwright', '.auth');
export const STORAGE_STATE_PATH = path.join(AUTH_DIR, 'user.json');
export const USER_META_PATH = path.join(AUTH_DIR, 'user-meta.json');

export interface UserMeta {
  /** Strings identifying the logged-in user (display name, handle, id). Replaced with [test-user]. */
  userTerms: string[];
  detectedAt: string;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function looksLikeToken(v: string): boolean {
  return v.length >= 16 && !/\s/.test(v);
}

/** Collect literal secret strings from the saved storage state without ever printing them. */
function secretsFromStorageState(file: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(file)) return out;
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const c of state.cookies || []) {
      if (typeof c.value === 'string' && c.value.length >= 8) {
        out.push(c.value);
        try {
          const dec = decodeURIComponent(c.value);
          if (dec !== c.value) out.push(dec);
        } catch {
          /* not url-encoded */
        }
      }
    }
    const walk = (v: unknown, keyIsSecret: boolean) => {
      if (typeof v === 'string') {
        if (keyIsSecret && v.length >= 8) out.push(v);
        else if (/^eyJ[\w-]{8,}\.[\w-]{8,}\./.test(v)) out.push(v);
        // JSON nested in a string (very common in localStorage)
        if (v.length < 200_000 && /^[[{]/.test(v.trim())) {
          try {
            walk(JSON.parse(v), keyIsSecret);
          } catch {
            /* not json */
          }
        }
      } else if (Array.isArray(v)) v.forEach((x) => walk(x, keyIsSecret));
      else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) walk(x, keyIsSecret || SECRET_KEY_RE.test(k));
      }
    };
    for (const o of state.origins || []) {
      for (const item of o.localStorage || []) {
        const secretKey = SECRET_KEY_RE.test(item.name || '');
        if (typeof item.value === 'string' && secretKey && looksLikeToken(item.value)) out.push(item.value);
        walk(item.value, secretKey);
      }
      if (o.indexedDB) walk(o.indexedDB, false);
    }
  } catch {
    /* unreadable state: nothing to add */
  }
  return out;
}

export class Redactor {
  private literals: string[] = [];
  private userTerms: string[] = [];
  private literalRe: RegExp | null = null;
  private userRe: RegExp | null = null;

  constructor(opts: { secrets?: string[]; userTerms?: string[] } = {}) {
    this.addSecrets(opts.secrets || []);
    this.addUserTerms(opts.userTerms || []);
  }

  /** Build a redactor from the environment + saved auth files. */
  static fromEnv(): Redactor {
    const secrets: string[] = [];
    for (const k of ['TEST_PASSWORD', 'TEST_EMAIL']) {
      const v = process.env[k];
      if (v && v.length >= 4) secrets.push(v);
    }
    secrets.push(...secretsFromStorageState(STORAGE_STATE_PATH));
    const userTerms: string[] = (process.env.REDACT_TERMS || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length >= 3);
    try {
      const meta: UserMeta = JSON.parse(fs.readFileSync(USER_META_PATH, 'utf8'));
      userTerms.push(...(meta.userTerms || []));
    } catch {
      /* no meta yet */
    }
    return new Redactor({ secrets, userTerms });
  }

  addSecrets(values: string[]) {
    for (const v of values) if (v && v.length >= 4 && !this.literals.includes(v)) this.literals.push(v);
    this.literals.sort((a, b) => b.length - a.length);
    this.literalRe = this.literals.length ? new RegExp(this.literals.map(escapeRe).join('|'), 'g') : null;
  }

  addUserTerms(values: string[]) {
    for (const v of values) if (v && v.length >= 3 && !this.userTerms.includes(v)) this.userTerms.push(v);
    this.userTerms.sort((a, b) => b.length - a.length);
    // whole-word match, so a short first name does not eat the middle of unrelated words
    this.userRe = this.userTerms.length ? new RegExp(`(?<![A-Za-z0-9])(?:${this.userTerms.map(escapeRe).join('|')})(?![A-Za-z0-9])`, 'gi') : null;
  }

  get knownSecrets(): readonly string[] {
    return this.literals;
  }
  get knownUserTerms(): readonly string[] {
    return this.userTerms;
  }

  /**
   * Literal-only redaction: known secret values and the account's identifiers, nothing pattern-based.
   * For large machine-generated documents (Lighthouse JSON/HTML) whose structure must stay intact.
   */
  literal(input: string): string {
    let s = input;
    if (this.literalRe) s = s.replace(this.literalRe, REDACTED);
    if (this.userRe) s = s.replace(this.userRe, USER_PLACEHOLDER);
    return s;
  }

  /** Redact a free-form string (console text, raw body, selector, error message). */
  text(input: string | null | undefined): string {
    if (input == null) return '';
    let s = String(input);
    if (this.literalRe) s = s.replace(this.literalRe, REDACTED);
    // JWT
    s = s.replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, REDACTED);
    // Bearer / Basic credentials
    s = s.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`);
    // "secretKey":"value" or secretKey=value inside raw text
    s = s.replace(/("?)([A-Za-z0-9_.-]*)("?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|[^\s"&,;}\]]+)/g, (m, q1, key, sep, val) => {
      if (!key || !(SECRET_KEY_RE.test(key) || PII_KEY_RE.test(key))) return m;
      if (/^(null|true|false|""|0)$/.test(val)) return m;
      return `${q1}${key}${sep}${val.startsWith('"') ? `"${REDACTED}"` : REDACTED}`;
    });
    if (this.userRe) s = s.replace(this.userRe, USER_PLACEHOLDER);
    return s;
  }

  /** Redact secret query-string parameters (and literals) in a URL. */
  url(input: string): string {
    let u = input;
    if (/^data:/i.test(u)) return u.slice(0, 60) + (u.length > 60 ? '…[data-uri]' : '');
    const qi = u.indexOf('?');
    if (qi >= 0) {
      const hashI = u.indexOf('#', qi);
      const query = u.slice(qi + 1, hashI >= 0 ? hashI : undefined);
      const rest = hashI >= 0 ? u.slice(hashI) : '';
      const parts = query.split('&').map((kv) => {
        const eq = kv.indexOf('=');
        const k = eq >= 0 ? kv.slice(0, eq) : kv;
        let dk = k;
        try {
          dk = decodeURIComponent(k);
        } catch {
          /* keep raw */
        }
        if (eq >= 0 && (SECRET_KEY_RE.test(dk) || PII_KEY_RE.test(dk))) return `${k}=${REDACTED}`;
        return kv;
      });
      u = u.slice(0, qi + 1) + parts.join('&') + rest;
    }
    if (this.literalRe) u = u.replace(this.literalRe, REDACTED);
    u = u.replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, REDACTED);
    if (this.userRe) u = u.replace(this.userRe, USER_PLACEHOLDER);
    return u;
  }

  /** Redact a header map. Secret headers are dropped to [REDACTED]; the rest are text-redacted. */
  headers(h: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(h)) {
      const lk = k.toLowerCase();
      out[lk] = SECRET_HEADERS.has(lk) || SECRET_KEY_RE.test(lk) ? REDACTED : this.text(v);
    }
    return out;
  }

  /** Deep-redact a parsed JSON value by key, then by literal/pattern on every string. */
  json(value: unknown, depth = 0): unknown {
    if (depth > 12) return '[…]';
    if (typeof value === 'string') return this.text(value);
    // a bare number can be an identifier too (the account's numeric id)
    if (typeof value === 'number') return this.userTerms.includes(String(value)) ? USER_PLACEHOLDER : this.literals.includes(String(value)) ? REDACTED : value;
    if (Array.isArray(value)) return value.map((v) => this.json(v, depth + 1));
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const key = this.literal(k); // keys can embed identifiers as well, e.g. "active_today:<id>"
        if ((SECRET_KEY_RE.test(k) || PII_KEY_RE.test(k)) && v !== null && v !== '' && typeof v !== 'boolean') out[key] = REDACTED;
        else out[key] = this.json(v, depth + 1);
      }
      return out;
    }
    return value;
  }

  /**
   * Redact a body (request payload or response preview) and truncate to maxBytes.
   * JSON is parsed, redacted by key, re-serialised; anything else is treated as raw text.
   */
  body(raw: string | null | undefined, maxBytes: number): { text: string; truncated: boolean; bytes: number } | null {
    if (raw == null || raw === '') return null;
    const bytes = Buffer.byteLength(raw, 'utf8');
    let text: string;
    const trimmed = raw.trimStart();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        // key-based + per-string redaction, then a literal pass over the serialised text as a safety net
        text = this.literal(JSON.stringify(this.json(JSON.parse(raw))));
      } catch {
        text = this.text(raw);
      }
    } else {
      text = this.text(raw);
    }
    const truncated = Buffer.byteLength(text, 'utf8') > maxBytes;
    if (truncated) text = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8').replace(/�$/, '') + '…';
    return { text, truncated, bytes };
  }
}

/** Scan a file for literal secrets. Returns the number of hits per secret index (never the secret itself). */
export function scanFileForSecrets(file: string, secrets: readonly string[]): { index: number; hits: number }[] {
  const content = fs.readFileSync(file, 'utf8');
  const found: { index: number; hits: number }[] = [];
  secrets.forEach((s, index) => {
    if (!s || s.length < 4) return;
    let hits = 0;
    let pos = content.indexOf(s);
    while (pos !== -1) {
      hits++;
      pos = content.indexOf(s, pos + s.length);
    }
    if (hits) found.push({ index, hits });
  });
  return found;
}
