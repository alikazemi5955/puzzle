// دستیار هوشمند خرید مشتری — فقط از اطلاعات واقعی فروشگاه پاسخ می‌دهد.
// قیمت، موجودی و مشخصات هرگز از خود مدل گرفته نمی‌شود؛ سرور کاتالوگ موجود را به مدل می‌دهد
// و خروجی مدل (شناسه‌ها) دوباره با دیتابیس اعتبارسنجی می‌شود.

const MAX_CATALOG = 60;
const MAX_QUERY = 600;
const HIDDEN_FIELDS = ['sourcePrice', 'syncedPrice', 'referenceSupplierId', 'referenceSupplierName', 'supplierName', 'supplierMatches', 'priceJumpHeldSource', 'approvedSourcePrice'];

export interface AssistantHints {
  budget?: unknown;
  priority?: unknown;
  brand?: unknown;
}

export interface AssistantResult {
  ok: boolean;
  summary?: string;
  products?: any[];
  error?: string;
}

const hits = new Map<string, number[]>();
export function assistantRateLimited(key: string, max = 10, windowMs = 60_000): boolean {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return true; }
  arr.push(now);
  hits.set(key, arr);
  if (hits.size > 5000) hits.clear();
  return false;
}

function isAvailable(p: any): boolean {
  if (!p || p.active === false) return false;
  if (p.inStock === false) return false;
  if (!(Number(p.price) > 0)) return false;
  if (Array.isArray(p.colors) && p.colors.length > 0 && !p.colors.some((c: any) => c && c.inStock !== false && Number(c.stock ?? 1) !== 0)) return false;
  return true;
}

function compact(p: any) {
  const colors = (Array.isArray(p.colors) ? p.colors : [])
    .filter((c: any) => c && c.inStock !== false && Number(c.stock ?? 1) !== 0)
    .map((c: any) => ({ name: String(c.name), price: Number(c.price) || Number(p.price) }));
  const specs: string[] = [];
  for (const g of Array.isArray(p.specifications) ? p.specifications : []) {
    for (const it of Array.isArray(g?.items) ? g.items : []) {
      if (specs.length < 14 && it?.label && it?.value) specs.push(`${it.label}: ${it.value}`);
    }
  }
  return {
    id: String(p.id),
    name: String(p.persianName || p.name),
    brand: String(p.brand || ''),
    price: Number(p.price),
    colors,
    specs,
    features: (Array.isArray(p.keyFeatures) ? p.keyFeatures : []).slice(0, 5).map(String),
  };
}

function score(p: any, tokens: string[]): number {
  const hay = `${p.persianName || ''} ${p.name || ''} ${p.brand || ''}`.toLowerCase();
  return tokens.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0);
}

function stripInternal(p: any) {
  const copy = { ...p };
  for (const f of HIDDEN_FIELDS) delete copy[f];
  return copy;
}

function parseJson(text: string): any | null {
  try {
    const t = String(text || '').replace(/```json|```/g, '').trim();
    const s = t.indexOf('{'), e = t.lastIndexOf('}');
    return s >= 0 && e > s ? JSON.parse(t.slice(s, e + 1)) : null;
  } catch { return null; }
}

const SYSTEM = `تو یک دستیار هوشمند و کارشناس ارشد مشاوره خرید کالای دیجیتال در فروشگاه «پازل کالا» هستی (مانند ChatGPT).
مشتریان به زبان فارسی با تو صحبت و چت می‌کنند تا:
۱. مشورت تخصصی خرید بگیرند (مثلاً انتخاب بین مدل‌ها، مناسب بودن برای بازی، عکاسی، کارهای روزمره یا اداری).
۲. استعلام قیمت روز بگیرند و رنج‌های قیمتی مختلف (مثلاً گوشی‌های تا ۱۵ میلیون، ۲۰ تا ۳۰ میلیون، پرچمدار و...) را بررسی کنند.
۳. مدل‌های مختلف را با هم مقایسه کنند (پردازنده، دوربین، باتری، صفحه‌نمایش، نقاط قوت و ضعف و ارزش خرید نسبت به قیمت).
۴. در صورت وجود کالاهای مرتبط در کاتالوگ فروشگاه پازل کالا، شناسه‌های (id) آن‌ها را پیشنهاد دهی.

اصول پاسخ‌گویی:
- لحنی صمیمی، حرفه‌ای، محترمانه، راهنما و کاملاً طبیعی به زبان فارسی داشته باش.
- اگر مشتری رنج قیمتی داد، ۲ تا ۴ مدل برتر بازار در همان رنج را با مشخصات کلیدی معرفی کن و تفاوت‌ها را توضیح بده.
- اگر مشتری خواست دو گوشی یا گجت را مقایسه کند، مقایسه‌ای شفاف، منظم و دقیق در بخش‌های دوربین، پردازنده، باتری، نمایشگر و نتیجه‌گیری نهایی ارائه بده.
- به هیچ عنوان پیام مشتری را به بهانه نبودن در کاتالوگ رد نکن؛ اطلاعات فنی و بازار عمومی را با دقت پاسخ بده و اگر کالای مرتبط در کاتالوگ پازل کالا بود، آن را هم معرفی کن.
- پاسخ نهایی خود را در قالب یک شیء JSON با ساختار زیر بده:
{
  "summary": "متن کامل، خوانا و ساختاریافته پاسخ تو به مشتری با فرمت‌بندی زیبا و بولت‌پوینت در صورت نیاز",
  "productIds": ["شناسه۱", "شناسه۲"]
}
اگر هیچ کالای مستقیمی از کاتالوگ تطبیق نداشت، آرایه productIds را خالی [] بگذار اما در summary پاسخ کامل و عالی به مشتری بده.`;

export async function runShoppingAssistant(allProducts: any[], queryRaw: unknown, hints: AssistantHints = {}): Promise<AssistantResult> {
  const query = String(queryRaw ?? '').trim().slice(0, MAX_QUERY);
  if (!query) return { ok: false, error: 'پرسش خالی است.' };

  let pool = allProducts.filter(isAvailable);
  const byId = new Map(allProducts.map((p) => [String(p.id), p]));
  const tokens = `${query} ${hints.brand || ''}`.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  if (pool.length > MAX_CATALOG) {
    pool = pool
      .map((p) => ({ p, s: score(p, tokens) }))
      .sort((a, b) => b.s - a.s || Number(a.p.price) - Number(b.p.price))
      .slice(0, MAX_CATALOG)
      .map((x) => x.p);
  }
  const catalog = pool.map(compact);

  const key = process.env.GEMINI_API_KEY;
  if (key) {
    try {
      const { GoogleGenAI } = await import('@google/genai');
      const ai: any = new GoogleGenAI({ apiKey: key });
      const prompt = `${SYSTEM}\n\nکاتالوگ محصولات پازل کالا (در صورت مرتبط بودن پیشنهاد بده):\n${JSON.stringify(catalog)}\n\nپیام یا درخواست مشتری:\n${query}`;
      const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';

      let r: any = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          r = await ai.models.generateContent({
            model,
            contents: prompt,
            config: { temperature: 0.3 },
          });
          if (r?.text) break;
        } catch (e: any) {
          await new Promise((res) => setTimeout(res, 600));
        }
      }

      if (r?.text) {
        const out = parseJson(r.text);
        if (out && typeof out.summary === 'string') {
          const ids: string[] = Array.isArray(out.productIds) ? out.productIds.map(String) : [];
          const products = [...new Set(ids)].filter((id) => byId.has(id)).slice(0, 4).map((id) => stripInternal(byId.get(id)));
          return { ok: true, summary: out.summary, products };
        }
      }
    } catch (err: any) {
      console.warn('[Assistant] Gemini error, falling back:', err?.message);
    }
  }

  // Fallback Rule-Based Consultant
  const matched = pool
    .map((p) => ({ p, s: score(p, tokens) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 3)
    .map((x) => x.p);

  let summary = '';
  if (matched.length > 0) {
    summary = `در پاسخ به درخواست شما در خصوص «${query}»، گزینه‌های پیشنهادی زیر در پازل کالا بررسی شدند:\n\n` +
      matched.map((m, i) => `${i + 1}. **${m.persianName || m.name}**\n   - قیمت: ${(Number(m.price) || 0).toLocaleString('fa-IR')} تومان\n   - وضعیت: آماده تحویل از انبار`).join('\n\n') +
      `\n\nهمچنین می‌توانید بودجه، برند دلخواه یا اولویت‌هایی مانند دوربین یا باتری را بفرمایید تا دقیق‌ترین مقایسه را انجام دهم.`;
  } else {
    summary = `درود! در خصوص درخواست شما «${query}»:\n\n` +
      `برای ارائه دقیق‌ترین مشاوره خرید، لطفاً بفرمایید:\n` +
      `• بودجه تقریبی مدنظرتان چقدر است؟ (مثلاً ۱۰ تا ۱۵ میلیون یا ۲۰ تا ۳۰ میلیون تومان)\n` +
      `• اولویت اصلی شما چیست؟ (عکاسی با دوربین، پردازنده گیمینگ، نگهداری شارژ باتری یا خوش‌دستی)\n` +
      `• به برند خاصی مانند سامسونگ، شیائومی یا اپل علاقه‌مندید؟\n\n` +
      `به محض اعلام، بهترین مدل‌های روز را با قیمت و مشخصات مقایسه و معرفی خواهم کرد.`;
  }

  return {
    ok: true,
    summary,
    products: matched.map(stripInternal),
  };
}
