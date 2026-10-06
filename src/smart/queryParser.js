"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BRANDS = exports.toLatinDigits = void 0;
exports.parseQuery = parseQuery;
const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹', AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const toLatinDigits = (s) => s.replace(/[۰-۹]/g, (c) => String(FA_DIGITS.indexOf(c))).replace(/[٠-٩]/g, (c) => String(AR_DIGITS.indexOf(c)));
exports.toLatinDigits = toLatinDigits;
// [نام انگلیسی, نام فارسی, هم‌نام‌ها]
exports.BRANDS = [
    ['Samsung', 'سامسونگ', ['samsung', 'سامسونگ', 'سامسونج', 'galaxy', 'گلکسی']],
    ['Apple', 'اپل', ['apple', 'اپل', 'iphone', 'ایفون', 'آیفون', 'ایپون']],
    ['Xiaomi', 'شیائومی', ['xiaomi', 'شیائومی', 'شیایومی', 'redmi', 'ردمی', 'ریدمی', 'mi ']],
    ['Poco', 'پوکو', ['poco', 'پوکو']],
    ['Realme', 'ریلمی', ['realme', 'ریلمی', 'رئلمی']],
    ['Honor', 'آنر', ['honor', 'آنر', 'هونر']],
    ['Huawei', 'هوآوی', ['huawei', 'هوآوی', 'هواوی']],
    ['Nokia', 'نوکیا', ['nokia', 'نوکیا']],
    ['Motorola', 'موتورولا', ['motorola', 'موتورولا', 'moto ']],
    ['Google', 'گوگل', ['google', 'گوگل', 'pixel', 'پیکسل']],
    ['OnePlus', 'وان‌پلاس', ['oneplus', 'وان پلاس', 'وانپلاس', 'وان‌پلاس']],
    ['Tecno', 'تکنو', ['tecno', 'تکنو']],
    ['Infinix', 'اینفینیکس', ['infinix', 'اینفینیکس']],
    ['Oppo', 'اوپو', ['oppo', 'اوپو']],
    ['Vivo', 'ویوو', ['vivo', 'ویوو']],
    ['Nothing', 'ناتینگ', ['nothing phone', 'ناتینگ']],
];
// معادل‌های فارسی واژه‌های رایج مدل
const WORD_MAP = [
    [/ایفون|آیفون|ایپون/g, 'iPhone'], [/گلکسی/g, 'Galaxy'], [/پیکسل/g, 'Pixel'], [/ردمی|ریدمی/g, 'Redmi'], [/نوت/g, 'Note'],
    [/پرو\s*مکس/g, 'Pro Max'], [/پرو/g, 'Pro'], [/مکس/g, 'Max'], [/پلاس/g, 'Plus'], [/اولترا/g, 'Ultra'], [/ماینی|مینی/g, 'mini'],
    [/نرمال/g, ''], [/فولد/g, 'Fold'], [/فلیپ/g, 'Flip'], [/اس\s*(?=\d)/g, 'S'], [/ای\s*(?=\d)/g, 'A'],
];
function parseQuery(raw) {
    const lat = (0, exports.toLatinDigits)(String(raw || '')).replace(/[‌_]/g, ' ').replace(/\s+/g, ' ').trim();
    const lower = lat.toLowerCase();
    let brandEn, brandFa;
    for (const [en, fa, aliases] of exports.BRANDS)
        if (aliases.some((a) => lower.includes(a.toLowerCase()))) {
            brandEn = en;
            brandFa = fa;
            break;
        }
    let ram, storage;
    let rest = lat;
    const pair = lower.match(/(?<![\d.])(\d{1,2})\s*[\/\\+\-x×]\s*(\d{2,4})(?!\d)/); // 8/256
    if (pair && [1, 2, 3, 4, 6, 8, 10, 12, 16, 18, 24].includes(+pair[1]) && [16, 32, 64, 128, 256, 512, 1024].includes(+pair[2])) {
        ram = +pair[1];
        storage = +pair[2];
        rest = rest.replace(pair[0], ' ');
    }
    const tb = lower.match(/(\d)\s*(?:tb|ترا)/);
    if (!storage && tb) {
        storage = +tb[1] * 1024;
        rest = rest.replace(tb[0], ' ');
    }
    const ramM = lower.match(/(?:رم|ram)\s*(\d{1,2})|(?<![a-z0-9])(?:\b)(\d{1,2})\s*(?:gb|gig(?:abyte)?|گیگابایت|گیگا\s*بایت|گیگا|گیگ)?\s*(?:رم|ram)/i);
    if (!ram && ramM) {
        ram = +(ramM[1] || ramM[2]);
        rest = rest.replace(ramM[0], ' ');
    }
    // اعداد دارای واحد گیگ: اگر دو عدد باشد، کوچک‌تر رم و بزرگ‌تر حافظه است
    const unitRe = /(\d{1,4})\s*(?:gb|g\b|gig(?:abyte)?|گیگابایت|گیگا\s*بایت|گیگا|گیگ)/gi;
    const units = [];
    for (const m of lower.matchAll(unitRe))
        units.push({ n: +m[1], txt: m[0] });
    const stSet = [16, 32, 64, 128, 256, 512, 1024];
    const stU = units.filter((u) => stSet.includes(u.n) && u.n >= 32), ramU = units.filter((u) => [1, 2, 3, 4, 6, 8, 10, 12, 16, 18, 24].includes(u.n) && u.n <= 24);
    if (!storage && stU.length) {
        const u = stU[stU.length - 1];
        storage = u.n;
        rest = rest.replace(new RegExp(u.txt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ' ');
    }
    if (!ram && ramU.length && storage) {
        const u = ramU.find((x) => x.n < storage);
        if (u) {
            ram = u.n;
            rest = rest.replace(new RegExp(u.txt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ' ');
        }
    }
    // عدد خالی بدون واحد (مثل «ایفون 16 نرمال 128»): فقط ۶۴ و بالاتر پذیرفته می‌شود تا شماره مدل (۱۶، ۱۴…) به‌عنوان حافظه اشتباه گرفته نشود
    if (!storage) {
        const bare = [...rest.matchAll(/(?<![\d.])(64|128|256|512|1024)(?![\d.])/g)];
        if (bare.length) {
            const b = bare[bare.length - 1];
            storage = +b[1];
            rest = rest.slice(0, b.index) + ' ' + rest.slice((b.index || 0) + b[0].length);
        }
    }
    for (const [re, to] of WORD_MAP)
        rest = rest.replace(re, ' ' + to + ' ');
    rest = rest.replace(/(?:سامسونگ|اپل|شیائومی|پوکو|ریلمی|آنر|هوآوی|نوکیا|موتورولا|گوگل|وان.?پلاس|گوشی|موبایل|مدل|ظرفیت|حافظه|گیگابایت|گیگا\s*بایت|گیگا|گیگ|دو سیم ?کارت|رم)/gi, ' ').replace(/\s+/g, ' ').trim();
    if (brandEn)
        rest = rest.replace(new RegExp(`\\b${brandEn}\\b`, 'i'), ' ').replace(/\s+/g, ' ').trim();
    const variantHints = ['5g', '4g', 'fe', 'ultra', 'plus', 'pro max', 'pro', 'mini', 'max', 'fold', 'flip', 'lite'].filter((v) => new RegExp(`(^|\\s)${v}(\\s|$)`, 'i').test(rest.toLowerCase()));
    return { raw: String(raw || ''), normalized: lat, brandEn, brandFa, modelText: rest, ram, storage, variantHints };
}
