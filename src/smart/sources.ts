// منابع استعلام: دیجی‌کالا (اختیاری و best-effort) + هوش مصنوعی با جستجوی وب. هر منبع ممکن است خطا بدهد و نباید کل فرایند را بشکند.
import type { ParsedQuery } from './queryParser.js';

export interface DkCandidate { id: number; title: string; image?: string }
export interface DkProduct { id: number; title: string; images: string[]; colors: { name: string; colorCode?: string }[]; specs: { title?: string; label: string; value: string }[]; url: string }
export interface Sources {
  digikalaSearch(q: string): Promise<DkCandidate[]>;
  digikalaProduct(id: number): Promise<DkProduct | null>;
}

const J = async (url: string, ms = 9000): Promise<any | null> => {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { const r = await fetch(url, { signal: ctl.signal, headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 PuzzleKalaBot' } }); return r.ok ? await r.json() : null; } catch { return null; } finally { clearTimeout(t); }
};

export const liveSources: Sources = {
  async digikalaSearch(q) {
    const d = await J(`https://api.digikala.com/v1/search/?q=${encodeURIComponent(q)}&page=1`);
    const list = d?.data?.products; if (!Array.isArray(list)) return [];
    return list.slice(0, 8).map((p: any) => ({ id: Number(p.id), title: String(p.title_fa || ''), image: p.images?.main?.url?.[0] })).filter((p: DkCandidate) => p.id && p.title);
  },
  async digikalaProduct(id) {
    const d = await J(`https://api.digikala.com/v2/product/${id}/`); const p = d?.data?.product; if (!p) return null;
    const images = [p.images?.main?.url?.[0], ...(p.images?.list || []).map((i: any) => i?.url?.[0])].filter(Boolean).map((u: string) => u.split('?')[0]);
    const colors = (p.colors || []).map((c: any) => ({ name: String(c.title || ''), colorCode: c.hex_code ? '#' + String(c.hex_code).replace('#', '') : undefined })).filter((c: any) => c.name);
    const specs: DkProduct['specs'] = [];
    for (const g of p.specifications || []) for (const a of g.attributes || []) { const v = Array.isArray(a.values) ? a.values.join('، ') : ''; if (a.title && v) specs.push({ title: g.title, label: String(a.title), value: v }); }
    return { id, title: String(p.title_fa || ''), images, colors, specs, url: `https://www.digikala.com/product/dkp-${id}/` };
  },
};

const norm = (s: string) => String(s || '').toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]+/g, ' ');
/** بهترین کاندیدای دیجی‌کالا برای ورودی (فقط اگر برند/مدل/رم/حافظه سازگار باشد) */
export function pickDigikala(list: DkCandidate[], q: ParsedQuery): DkCandidate | null {
  const want = norm(q.modelText).split(' ').filter((t) => t.length > 1);
  let best: { c: DkCandidate; s: number } | null = null;
  for (const c of list) {
    const t = norm(c.title); if (/قاب|گارد|کاور|محافظ|شارژر|هندزفری|کابل/.test(t)) continue;
    const hit = want.filter((w) => t.includes(w)).length; let s = want.length ? hit / want.length : 0;
    if (q.storage && !new RegExp(`${q.storage}\\s*(گیگ|gb)`).test(t)) s -= 0.4;
    if (q.ram && !new RegExp(`(رم|ram)\\s*${q.ram}|${q.ram}\\s*(گیگابایت)?\\s*رم`).test(t)) s -= 0.2;
    if (!best || s > best.s) best = { c, s };
  }
  return best && best.s >= 0.6 ? best.c : null;
}
