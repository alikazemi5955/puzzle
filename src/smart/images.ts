// دریافت، بررسی و ذخیره عکس‌های محصول (زمینه سفید، حداقل کیفیت، حذف تکراری). sharp اختیاری است.
import fs from 'fs';
import path from 'path';

export interface Candidate { url: string; source: string; rank: number }
export interface Analyzed extends Candidate { buf: Buffer; w: number; h: number; whiteRatio: number | null; hash: string | null }
export interface ImageDeps { fetchBuffer?: (url: string) => Promise<Buffer | null>; sharp?: any | null }

export function isSafeUrl(u: string): boolean {
  try {
    const x = new URL(u);
    if (x.protocol !== 'https:') return false;
    const h = x.hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return false;
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(h)) { const [a, b] = h.split('.').map(Number); if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return false; }
    if (h.includes(':') || h.startsWith('[')) return false;
    return true;
  } catch { return false; }
}

export async function defaultFetchBuffer(url: string): Promise<Buffer | null> {
  if (!isSafeUrl(url)) return null;
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 9000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0 PuzzleKalaBot' } });
    if (!r.ok || !String(r.headers.get('content-type') || '').startsWith('image/')) return null;
    const ab = await r.arrayBuffer(); if (ab.byteLength < 4000 || ab.byteLength > 8e6) return null;
    return Buffer.from(ab);
  } catch { return null; } finally { clearTimeout(t); }
}

export async function loadSharp(): Promise<any | null> { try { const name = 'sharp'; const m: any = await import(name); return m.default || m; } catch { return null; } }

export async function analyze(c: Candidate, buf: Buffer, sharp: any | null): Promise<Analyzed | null> {
  if (!sharp) return { ...c, buf, w: 0, h: 0, whiteRatio: null, hash: null };
  try {
    const meta = await sharp(buf).metadata();
    const { data, info } = await sharp(buf).flatten({ background: '#fff' }).resize(32, 32, { fit: 'fill' }).greyscale().raw().toBuffer({ resolveWithObject: true });
    const px = info.width, border: number[] = [];
    for (let i = 0; i < px; i++) { border.push(data[i], data[(px - 1) * px + i], data[i * px], data[i * px + px - 1]); }
    const whiteRatio = border.filter((v) => v >= 238).length / border.length;
    const avg = data.reduce((a: number, v: number) => a + v, 0) / data.length;
    const hash = Array.from(data as Uint8Array).map((v) => (v >= avg ? '1' : '0')).join('');
    return { ...c, buf, w: meta.width || 0, h: meta.height || 0, whiteRatio, hash };
  } catch { return null; }
}

const hamming = (a: string, b: string) => { let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d; };

/** انتخاب ۴ تا ۶ عکس: فقط زمینه سفید و کیفیت کافی، بدون تکراری؛ کاور = بهترین رتبه (دیجی‌کالا/کسری) */
export function selectImages(list: Analyzed[], opts: { min?: number; max?: number } = {}) {
  const min = opts.min ?? 4, max = opts.max ?? 6, warnings: string[] = [];
  const hasSharp = list.some((x) => x.whiteRatio !== null);
  let ok = list.filter((x) => (!hasSharp || (x.whiteRatio! >= 0.9 && Math.min(x.w, x.h) >= 500)));
  ok.sort((a, b) => a.rank - b.rank);
  const out: Analyzed[] = [];
  for (const c of ok) { if (c.hash && out.some((o) => o.hash && hamming(o.hash, c.hash!) <= 4)) continue; out.push(c); if (out.length >= max) break; }
  if (!hasSharp) warnings.push('کتابخانه sharp نصب نیست؛ زمینه سفید و کیفیت عکس‌ها بررسی نشد (npm i sharp).');
  if (out.length < min) warnings.push(`فقط ${out.length} عکس معتبر با زمینه سفید پیدا شد (هدف ${min} تا ${max}).`);
  return { selected: out, warnings };
}

export async function saveImages(slug: string, sel: Analyzed[], sharp: any | null, root = path.resolve(process.cwd(), 'public', 'uploads', 'products')) {
  const safe = slug.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'product';
  const dir = path.join(root, safe); fs.mkdirSync(dir, { recursive: true });
  const urls: string[] = [];
  for (let i = 0; i < sel.length; i++) {
    const file = `img-${i + 1}.jpg`;
    const out = sharp ? await sharp(sel[i].buf).flatten({ background: '#fff' }).resize(1000, 1000, { fit: 'contain', background: '#fff' }).jpeg({ quality: 88 }).toBuffer() : sel[i].buf;
    fs.writeFileSync(path.join(dir, file), out); urls.push(`/uploads/products/${safe}/${file}`);
  }
  return urls;
}
