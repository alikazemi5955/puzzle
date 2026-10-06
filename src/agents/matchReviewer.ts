// ایجنت ۲: بازبینی تطبیق محصول. فقط پیشنهاد می‌دهد؛ هرگز چیزی را خودکار اعمال نمی‌کند.
import { buildProductProfile, validateProductCompatibility, normalizeText } from '../supplierEngine.js';
import { readJson, loadCatalogs, saveReport } from './common.js';
import type { AgentAlert } from './common.js';

const tokens = (t: string) => new Set(normalizeText(t).split(/\s+/).filter((w) => w.length > 1));
const jaccard = (a: Set<string>, b: Set<string>) => { let i = 0; a.forEach((x) => b.has(x) && i++); return a.size + b.size - i ? i / (a.size + b.size - i) : 0; };
const itemText = (i: any) => i.title || i.name || i.product_name_en || i.persianName || i.product_name || '';

async function askGemini(master: any, cands: any[]): Promise<{ choice: number | null; confidence: number; reason: string } | null> {
  const key = process.env.GEMINI_API_KEY; if (!key) return null;
  try {
    const { GoogleGenAI } = await import('@google/genai');
    const ai = new GoogleGenAI({ apiKey: key });
    const prompt = `محصول فروشگاه: ${master.persianName || master.name}\nگزینه‌های تأمین‌کننده:\n${cands.map((c, i) => `${i}: ${itemText(c.item)}`).join('\n')}\nفقط اگر دقیقاً همان دستگاه است (مدل، رم، حافظه، کشور سازنده، تعداد سیم‌کارت یکسان) انتخاب کن، وگرنه null. خروجی فقط JSON: {"choice":number|null,"confidence":0..1,"reason":"..."}`;
    const r: any = await ai.models.generateContent({ model: 'gemini-2.5-flash', contents: prompt });
    const m = String(r.text || '').match(/\{[\s\S]*\}/); if (!m) return null;
    const j = JSON.parse(m[0]);
    return { choice: typeof j.choice === 'number' ? j.choice : null, confidence: Math.max(0, Math.min(1, Number(j.confidence) || 0)), reason: String(j.reason || '') };
  } catch { return null; }
}

export async function runMatchReviewer(opts: { productIds?: string[]; catalogs?: Awaited<ReturnType<typeof loadCatalogs>> } = {}) {
  const products = readJson<any[]>('products.json', []).filter((p) => p.active !== false && (!opts.productIds || opts.productIds.includes(p.id)));
  const catalogs = opts.catalogs ?? (await loadCatalogs());
  const alerts: AgentAlert[] = [], suggestions: any[] = [];

  for (const p of products) {
    const mp = buildProductProfile(p), mt = tokens(p.name + ' ' + (p.persianName || ''));
    for (const { supplier, adapter, items, error } of catalogs) {
      if (error || !items.length) continue;
      const current = adapter.matchProduct(p, items);
      if (current && (current.confidence === 'exact' || current.confidence === 'high')) continue; // قبلاً مطمئن تطبیق خورده
      const cands = items
        .map((item) => ({ item, compat: validateProductCompatibility(mp, buildProductProfile(item)), score: jaccard(mt, tokens(itemText(item))) }))
        .filter((c) => c.compat.compatible && c.score > 0.25).sort((a, b) => b.score - a.score).slice(0, 5);
      if (!cands.length) continue;
      const ai = await askGemini(p, cands);
      const idx = ai ? ai.choice : 0;
      const pick = idx !== null && cands[idx] ? cands[idx] : null;
      const confidence = ai ? ai.confidence : Math.min(0.7, cands[0].score);
      if (!pick) continue;
      const s = { productId: p.id, productName: p.name, supplierId: supplier.id, supplierName: supplier.name, candidate: itemText(pick.item), candidateId: pick.item.id ?? null,
        confidence: Number(confidence.toFixed(2)), method: ai ? 'gemini' : 'heuristic', reason: ai?.reason || 'شباهت نام + سازگاری رم/حافظه/برند', status: 'needs_review' };
      suggestions.push(s);
      alerts.push({ key: `match:${p.id}:${supplier.id}`, type: 'match_suggestion', severity: 'info', message: `برای «${p.name}» در ${supplier.name} پیشنهاد: «${s.candidate}» (اطمینان ${Math.round(s.confidence * 100)}٪، ${s.method === 'gemini' ? 'هوش مصنوعی' : 'قاعده‌ای'})`, data: s });
    }
  }
  return saveReport({ agent: 'matchReviewer', summary: suggestions.length ? `${suggestions.length} پیشنهاد تطبیق برای بازبینی` : 'تطبیق مبهمی پیدا نشد.', alerts, data: { suggestions } });
}
