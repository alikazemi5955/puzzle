import { parseQuery, type ParsedQuery } from './queryParser.js';
import { validateDraft, buildPersianName, WARRANTY_18M } from './validate.js';
import { liveSources, pickDigikala, type Sources, type DkProduct } from './sources.js';
import { liveAi, type AiDeps } from './ai.js';
import { analyze, defaultFetchBuffer, loadSharp, saveImages, selectImages, type Candidate, type ImageDeps } from './images.js';

export interface SmartDeps { ai?: AiDeps; sources?: Sources; images?: ImageDeps; saveRoot?: string }
const fa = (n?: number) => (n ? `${n >= 1024 ? n / 1024 + ' ترابایت' : n + ' گیگابایت'}` : undefined);
const slugOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export async function smartRegister(query: string, deps: SmartDeps = {}) {
  const ai = deps.ai ?? liveAi, src = deps.sources ?? liveSources, stages: string[] = [], warnings: string[] = [];
  const q: ParsedQuery = parseQuery(query);
  if (!q.brandEn && q.modelText.length < 2) return { success: false, message: 'برای تشخیص دقیق، برند یا مدل را بنویسید (مثلاً: سامسونگ A56 8/256 یا iPhone 16 128).', diagnostics: { stage: 'parse', parsed: q } };

  // ۱. شواهد دیجی‌کالا (اختیاری)
  let dk: DkProduct | null = null;
  try {
    const found = pickDigikala(await src.digikalaSearch(`${q.brandFa || ''} ${q.modelText} ${q.storage ?? ''}`.trim()), q);
    if (found) { dk = await src.digikalaProduct(found.id); stages.push('digikala'); }
  } catch { /* ادامه بدون دیجی‌کالا */ }
  if (!dk) warnings.push('اطلاعات دیجی‌کالا در دسترس نبود یا تطبیق مطمئن پیدا نشد.');

  // ۲. تحقیق هوش مصنوعی
  const research = await ai.research(q, dk).catch(() => null);
  if (!research) return { success: false, message: 'سرویس هوش مصنوعی در دسترس نیست. کلید GEMINI_API_KEY را در Secrets/.env تنظیم کنید و دوباره تلاش کنید.', warnings, diagnostics: { stage: 'ai-research', parsed: q, digikalaFound: Boolean(dk) } };
  stages.push(research.provider);
  const raw = { ...research.raw };
  // ادغام رنگ‌ها/مشخصات دیجی‌کالا (فقط اضافه می‌کند، چیزی را حذف نمی‌کند)
  if (dk) {
    const have = new Set((raw.colors || []).flatMap((c: any) => [c.name, c.nameEn].filter(Boolean).map((s: string) => s.toLowerCase())));
    for (const c of dk.colors) if (!have.has(c.name.toLowerCase())) (raw.colors ||= []).push({ name: c.name, colorCode: c.colorCode, available: true });
    if ((raw.technicalSpecs || []).length < 10) raw.technicalSpecs = [...(raw.technicalSpecs || []), ...dk.specs];
  }

  // ۳. اعتبارسنجی سخت‌گیرانه
  const chk = validateDraft(raw, q); warnings.push(...chk.warnings);
  if (chk.blockers.length) return { success: false, message: 'اطلاعات قابل اعتماد نبود و وارد فرم نشد: ' + chk.blockers.join(' | '), warnings, sources: research.sources, diagnostics: { stage: 'validation', parsed: q, blockers: chk.blockers, parsedModel: q.modelText, ram: q.ram, storage: q.storage, digikalaFound: Boolean(dk) } };
  const d = chk.draft; d.persianName = d.persianName.startsWith('گوشی') ? d.persianName : buildPersianName(d);

  // ۴. کنترل مستقل (اختیاری)
  let score = chk.score;
  const rv = await ai.review(q, d).catch(() => null);
  if (rv) { stages.push(rv.provider + '-review'); if (!rv.ok) { score -= 0.25; warnings.push(...rv.issues.map((i) => 'کنترل مستقل: ' + i)); } }
  else warnings.push('کنترل مستقل (ANTHROPIC_API_KEY) فعال نیست.');

  // ۵. عکس‌ها
  const cands: Candidate[] = (dk?.images || []).map((url, i) => ({ url, source: 'digikala', rank: i }));
  const sharp = deps.images && 'sharp' in deps.images ? deps.images.sharp : await loadSharp();
  const fetchBuf = deps.images?.fetchBuffer ?? defaultFetchBuffer;
  const got = (await Promise.all(cands.slice(0, 14).map(async (c) => { const b = await fetchBuf(c.url); return b ? analyze(c, b, sharp) : null; }))).filter(Boolean) as any[];
  const sel = selectImages(got); warnings.push(...sel.warnings);
  d.images = sel.selected.length ? await saveImages(slugOf(d.name), sel.selected, sharp, deps.saveRoot) : [];
  if (d.images.length < 4) score -= 0.1;

  score = Math.max(0, Math.min(1, Number(score.toFixed(2))));
  return {
    success: true,
    product: { ...d, warranty: WARRANTY_18M, ram: fa(d.ram), storage: fa(d.storage), brand: d.brand, modelCode: d.modelCode, source: 'puzzlekala' },
    meta: { confidence: score, parsedQuery: q, needsReview: score < 0.8 || d.images.length < 4 || warnings.length > 0, warnings, stages, sources: [...(dk ? [{ title: dk.title, url: dk.url }] : []), ...research.sources] },
  };
}
export { parseQuery };
