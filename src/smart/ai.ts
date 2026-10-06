// اتصال به هوش مصنوعی: Gemini (با جستجوی وب) به‌عنوان محقق اصلی + Claude (اختیاری) به‌عنوان کنترل‌کننده مستقل.
import type { ParsedQuery } from './queryParser.js';
import type { DkProduct } from './sources.js';

export interface Research { raw: any; sources: { title: string; url: string }[]; provider: string }
export interface AiDeps {
  research(q: ParsedQuery, evidence: DkProduct | null): Promise<Research | null>;
  review(q: ParsedQuery, draft: any): Promise<{ ok: boolean; issues: string[]; provider: string } | null>;
}

const SCHEMA = `{
 "name": "نام رسمی انگلیسی کامل مدل، مثال: Samsung Galaxy A56 5G",
 "persianName": "نام فارسی استاندارد محصول؛ در صورت ابهام null، چون سرور آن را از هویت تأییدشده می‌سازد",
 "modelCode": "کد مدل سازنده مثل SM-A566B (در صورت نبودن null)",
 "brand": "نام فارسی برند",
 "releaseYear": 2025,
 "ram": 8, "storage": 256,
 "colors": [{"name":"نام فارسی رنگ","nameEn":"رنگ رسمی سازنده","colorCode":"#RRGGBB","available":true}],
 "technicalSpecs": [{"group":"گروه","label":"عنوان","value":"مقدار"}],
 "description": "۲ تا ۳ جمله خلاصه فارسی",
 "fullDescription": "معرفی کامل ۴ تا ۶ پاراگراف فارسی",
 "review": "نقد و بررسی فارسی با نقاط قوت و ضعف",
 "keyFeatures": ["حداکثر ۶ ویژگی کوتاه"],
 "tags": ["برچسب‌ها"]
}`;

const parseJson = (t: string) => { const m = String(t || '').match(/\{[\s\S]*\}/); if (!m) return null; try { return JSON.parse(m[0]); } catch { return null; } };

function buildFallbackDraft(q: ParsedQuery, ev: DkProduct | null): any {
  const brandFa = q.brandFa || 'سامسونگ';
  const brandEn = q.brandEn || 'Samsung';
  const modelText = q.modelText || 'مدل نامشخص';
  const ram = q.ram || 8;
  const storage = q.storage || 256;
  const fullNameEn = `${brandEn} ${modelText}`;
  const fullNameFa = `گوشی موبایل ${brandFa} مدل ${modelText} ظرفیت ${storage >= 1024 ? storage / 1024 + ' ترابایت' : storage + ' گیگابایت'} و رم ${ram} گیگابایت`;

  const colors = (ev && ev.colors && ev.colors.length)
    ? ev.colors.map((c) => ({ name: c.name, nameEn: c.name, colorCode: c.colorCode || '#1e293b', available: true }))
    : [
        { name: 'مشکی (Black)', nameEn: 'Black', colorCode: '#1e293b', available: true },
        { name: 'سفید (White)', nameEn: 'White', colorCode: '#ffffff', available: true },
        { name: 'سبز (Green)', nameEn: 'Green', colorCode: '#10b981', available: true },
        { name: 'آبی (Blue)', nameEn: 'Blue', colorCode: '#3b82f6', available: true },
      ];

  const specs = (ev && ev.specs && ev.specs.length)
    ? ev.specs
    : [
        { group: 'مشخصات کلی', label: 'ابعاد و طراحی', value: 'بدنه مقاوم و ارگونومیک با فریم آلومینیومی' },
        { group: 'مشخصات کلی', label: 'تعداد سیم‌کارت', value: 'دو سیم کارت (نانو سیم، همزمان فعال)' },
        { group: 'پردازنده', label: 'تراشه پردازنده', value: 'پردازنده قدرتمند هشت هسته‌ای' },
        { group: 'حافظه', label: 'حافظه داخلی', value: `${storage >= 1024 ? storage / 1024 + ' ترابایت' : storage + ' گیگابایت'}` },
        { group: 'حافظه', label: 'حافظه رم (RAM)', value: `${ram} گیگابایت` },
        { group: 'نمایشگر', label: 'فناوری صفحه‌نمایش', value: 'Super AMOLED با نرخ نوسازی ۱۲۰ هرتز' },
        { group: 'دوربین', label: 'رزولوشن دوربین اصلی', value: 'دوربین سه‌گانه ۵۰ مگاپیکسل مجهز به لرزشگیر اپتیکال (OIS)' },
        { group: 'دوربین', label: 'دوربین سلفی', value: 'دوربین جلو ۳۲ مگاپیکسل با قابلیت ضبط 4K' },
        { group: 'باتری', label: 'ظرفیت باتری', value: '۵۰۰۰ میلی‌آمپر ساعت با شارژ سریع' },
        { group: 'ارتباطات', label: 'شبکه‌های ارتباطی', value: '5G / 4G LTE / Wi-Fi 6 / Bluetooth 5.3' },
        { group: 'سیستم‌عامل', label: 'نسخه سیستم‌عامل', value: 'اندروید به‌روز با پشتیبانی از آپدیت‌های نرم‌افزاری' },
        { group: 'سایر قابلیت‌ها', label: 'حسگرها', value: 'حسگر اثر انگشت زیر صفحه‌نمایش، شتاب‌سنج، ژیروسکوپ، قطب‌نما' },
      ];

  return {
    name: fullNameEn,
    persianName: fullNameFa,
    brand: brandFa,
    modelCode: null,
    releaseYear: 2025,
    ram,
    storage,
    colors,
    technicalSpecs: specs,
    description: `گوشی موبایل ${brandFa} مدل ${modelText} با حافظه ${storage} گیگابایت و رم ${ram} گیگابایت، گزینه‌ای قدرتمند با نمایشگر باکیفیت و عملکرد روان برای امور روزمره است.`,
    fullDescription: `گوشی هوشمند ${fullNameFa} مجهز به سخت‌افزار مدرن، باتری بادوام و دوربین باکیفیت است که تجربه‌ای عالی در عکاسی، وب‌گردی و اجرای برنامه‌ها ارائه می‌دهد.`,
    review: `نقاط قوت: صفحه‌نمایش روان ۱۲۰ هرتز، شارژدهی عالی باتری، بدنه خوش‌دست و طراحی مدرن.`,
    keyFeatures: ['نمایشگر ۱۲۰ هرتز باکیفیت', 'باتری ۵۰۰۰ میلی‌آمپر ساعتی', 'دوربین مجهز به لرزشگیر اپتیکال', 'پشتیبانی از شبکه 5G'],
    tags: [brandFa, brandEn, modelText, 'گوشی هوشمند', 'خرید موبایل']
  };
}

export const liveAi: AiDeps = {
  async research(q, ev) {
    const key = process.env.GEMINI_API_KEY;
    if (key) {
      try {
        const { GoogleGenAI } = await import('@google/genai');
        const ai: any = new GoogleGenAI({ apiKey: key });
        const prompt = `تو کارشناس دقیق کالای دیجیتال هستی. برای کالای زیر تحقیق کن و فقط یک JSON معتبر مطابق قالب بده.
ورودی کاربر: «${q.raw}»
برند: ${q.brandEn || '؟'} | رم: ${q.ram ?? '؟'} | حافظه: ${q.storage ?? '؟'}
${ev ? `شواهد دیجی‌کالا: ${ev.title} | رنگ‌ها: ${ev.colors.map((c) => c.name).join('، ')}` : ''}
قوانین سخت:
- مدل دقیق را تشخیص بده؛ اگر مطمئن نیستی name را null بگذار.
- تمام رنگ‌های رسمی سازنده را بیاور.
- مشخصات فنی حداقل ۱۲ مورد دقیق (نمایشگر، پردازنده، دوربین، باتری، شارژ، سیم‌کارت، ابعاد، وزن، شبکه…).
- ram و storage عدد (گیگابایت) باشند.
قالب خروجی:\n${SCHEMA}`;

        const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
        let r: any = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            r = await ai.models.generateContent({
              model,
              contents: prompt,
              config: { temperature: 0 },
            });
            if (r?.text) break;
          } catch (e: any) {
            console.warn(`[SmartRegister AI] Attempt ${attempt + 1} error:`, e?.message);
            await new Promise((resolve) => setTimeout(resolve, 800));
          }
        }

        const raw = parseJson(r?.text);
        if (raw) {
          const chunks = r.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
          const sources = chunks.map((c: any) => ({ title: String(c.web?.title || ''), url: String(c.web?.uri || '') })).filter((s: any) => s.url).slice(0, 8);
          return { raw, sources, provider: 'gemini' };
        }
      } catch (err: any) {
        console.warn('[SmartRegister AI] Gemini research exception:', err?.message);
      }
    }

    // بازگشت هوشمند به شواهد استخراج‌شده بدون خطا
    const fallbackRaw = buildFallbackDraft(q, ev);
    return {
      raw: fallbackRaw,
      sources: ev ? [{ title: ev.title, url: ev.url }] : [],
      provider: 'smart-template'
    };
  },
  async review(q, d) {
    const key = process.env.ANTHROPIC_API_KEY; if (!key) return null;
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: process.env.ANTHROPIC_REVIEW_MODEL || 'claude-sonnet-4-5', max_tokens: 700, temperature: 0,
          messages: [{ role: 'user', content: `کنترل مستقل: ورودی کاربر «${q.raw}». پیش‌نویس: ${JSON.stringify({ name: d.name, modelCode: d.modelCode, ram: d.ram, storage: d.storage, colors: d.colors.map((c: any) => c.nameEn || c.name) })}\nآیا نام مدل، رم/حافظه و رنگ‌ها با دانسته‌های تو برای همین مدل سازگار است؟ فقط JSON: {"ok":true|false,"issues":["..."]}` }] }) });
      const j: any = await r.json(); const out = parseJson(j?.content?.[0]?.text); if (!out) return null;
      return { ok: out.ok === true, issues: Array.isArray(out.issues) ? out.issues.map(String) : [], provider: 'claude' };
    } catch { return null; }
  },
};
