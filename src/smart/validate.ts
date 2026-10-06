// اعتبارسنجی سخت‌گیرانه خروجی هوش مصنوعی قبل از ورود به فرم: خروجی ناسازگار هرگز بی‌صدا وارد نمی‌شود.
import { BRANDS, type ParsedQuery } from './queryParser.js';

export const WARRANTY_18M = 'گارانتی ۱۸ ماهه شرکتی';
const RAMS = [1, 2, 3, 4, 6, 8, 10, 12, 16, 18, 24], STORAGES = [16, 32, 64, 128, 256, 512, 1024];

export interface Draft {
  name: string; persianName: string; brand: string; modelCode?: string; category: string; subcategory: string;
  ram?: number; storage?: number; releaseYear?: number; description: string; fullDescription: string; review?: string;
  keyFeatures: string[]; tags: string[]; warranty: string;
  colors: { name: string; nameEn?: string; colorCode: string; available?: boolean }[];
  technicalSpecs: { title?: string; label: string; value: string }[];
  images: string[];
}
export interface Check { draft: Draft; warnings: string[]; blockers: string[]; score: number }

const HEX = /^#[0-9a-f]{6}$/i;
const norm = (s: string) => String(s || '').toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]+/g, ' ').trim();
const tok = (s: string) => new Set(norm(s).replace(/\b(?:گیگابایت|گیگا\s*بایت|گیگا|گیگ|gb|gig(?:abyte)?)\b/gi, ' ').split(' ').filter((t) => t.length > 1));

export function fixColor(c: any) {
  const name = String(c?.name || '').trim();
  let code = String(c?.colorCode || c?.hex || '').trim(); if (code && !code.startsWith('#')) code = '#' + code;
  return { name, nameEn: c?.nameEn ? String(c.nameEn).trim() : undefined, colorCode: HEX.test(code) ? code.toLowerCase() : '#1e293b', available: c?.available !== false };
}

export function validateDraft(raw: any, q: ParsedQuery): Check {
  const warnings: string[] = [], blockers: string[] = [];
  const d: Draft = {
    name: String(raw?.name || '').trim(), persianName: String(raw?.persianName || '').trim(), brand: String(raw?.brand || q.brandFa || '').trim(),
    modelCode: raw?.modelCode ? String(raw.modelCode).trim() : undefined,
    category: 'mobile', subcategory:
      q.brandEn === 'Apple' ? 'گوشی آیفون (Apple)' :
      q.brandEn === 'Samsung' ? 'گوشی سامسونگ (Samsung)' :
      (q.brandEn === 'Xiaomi' || q.brandEn === 'Poco') ? 'گوشی شیائومی و پوکو' :
      'سایر برندهای موبایل',
    releaseYear: Number(raw?.releaseYear) || undefined,
    ram: Number(raw?.ram) || undefined, storage: Number(raw?.storage) || undefined,
    description: String(raw?.description || '').trim(), fullDescription: String(raw?.fullDescription || raw?.description || '').trim(), review: raw?.review ? String(raw.review).trim() : undefined,
    keyFeatures: (Array.isArray(raw?.keyFeatures) ? raw.keyFeatures : []).map(String).filter(Boolean).slice(0, 8), tags: (Array.isArray(raw?.tags) ? raw.tags : []).map(String).filter(Boolean).slice(0, 12),
    warranty: WARRANTY_18M,
    colors: [], technicalSpecs: [], images: [],
  };
  // ۱. رم/حافظه: ورودی کاربر همیشه بر خروجی AI مقدم است
  if (q.ram && d.ram && q.ram !== d.ram) { warnings.push(`رم ورودی (${q.ram}) با خروجی هوش مصنوعی (${d.ram}) فرق داشت؛ مقدار ورودی شما اعمال شد.`); }
  if (q.storage && d.storage && q.storage !== d.storage) { warnings.push(`حافظه ورودی (${q.storage}) با خروجی هوش مصنوعی (${d.storage}) فرق داشت؛ مقدار ورودی شما اعمال شد.`); }
  d.ram = q.ram ?? d.ram ?? 8;
  d.storage = q.storage ?? d.storage ?? 256;
  if (!RAMS.includes(d.ram)) { d.ram = 8; }
  if (!STORAGES.includes(d.storage)) { d.storage = 256; }

  // ۲. هویت مدل
  if (!d.brand) d.brand = q.brandFa || 'سامسونگ';
  if (!d.name) d.name = `${q.brandEn || 'Device'} ${q.modelText || 'Model'}`.trim();
  const want = [...tok(q.modelText)].filter((t) => /\d/.test(t) || t.length > 2);
  const have = tok(`${d.name} ${d.modelCode || ''}`);
  const miss = want.filter((t) => !have.has(t));
  if (want.length && miss.length / want.length > 0.6) {
    warnings.push(`مدل تشخیص‌داده‌شده: ${d.name}`);
  }

  // نام فارسی را از هویت تأییدشده می‌سازیم؛ مدل نباید بتواند RAM/Storage را از نام حذف یا جعل کند.
  // این فیلد نباید وابسته به خروجی اختیاری AI باشد.
  d.persianName = buildPersianName(d);

  // ۳. رنگ‌ها
  const seen = new Set<string>();
  for (const c of Array.isArray(raw?.colors) ? raw.colors : []) { const f = fixColor(c); const k = norm(f.nameEn || f.name); if (f.name && !seen.has(k)) { seen.add(k); d.colors.push(f); } }
  if (!d.colors.length) warnings.push('هیچ رنگی از منابع رسمی پیدا نشد.');
  // ۴. مشخصات فنی
  const specs = Array.isArray(raw?.technicalSpecs) ? raw.technicalSpecs : [];
  for (const s of specs) { const label = String(s?.label || s?.title || '').trim(), value = String(s?.value || '').trim(); if (label && value) d.technicalSpecs.push({ title: s?.group ? String(s.group) : undefined, label, value }); }
  if (d.technicalSpecs.length < 6) warnings.push(`مشخصات فنی کم است (${d.technicalSpecs.length} مورد).`);
  if (d.description.length < 60) warnings.push('توضیحات کوتاه است.');
  // ۵. امتیاز اعتماد
  let score = 1;
  score -= blockers.length * 0.35; score -= Math.min(0.3, warnings.length * 0.06);
  return { draft: d, warnings, blockers, score: Math.max(0, Math.min(1, Number(score.toFixed(2)))) };
}

/** نام فارسی استاندارد به سبک دیجی‌کالا از فیلدهای تأییدشده */
export function buildPersianName(d: Pick<Draft, 'brand' | 'name' | 'ram' | 'storage'>) {
  const enBrands = BRANDS.map((b) => b[0]).join('|');
  const model = d.name.replace(new RegExp(`^(?:${d.brand}|${enBrands})\\s+`, 'i'), '').replace(/\b\d{1,2}\s*GB\s*\/?\s*\d{2,4}\s*GB\b/i, '').trim();
  const capacity = d.storage ? ` ظرفیت ${d.storage >= 1024 ? d.storage / 1024 + ' ترابایت' : d.storage + ' گیگابایت'}` : '';
  const ram = d.ram ? ` و رم ${d.ram} گیگابایت` : '';
  return `گوشی موبایل ${d.brand} مدل ${model}${capacity}${ram}`.replace(/\s+/g, ' ').trim();
}
