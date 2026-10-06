import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';

const DATA_DIR = path.resolve(process.cwd(), 'data');

// ============================================================================
// 1. Types & Interfaces (Multi-Supplier Architecture)
// ============================================================================

export interface Supplier {
  id: string;
  name: string;
  enabled: boolean;
  baseUrl: string;
  connectionType: 'api_feed' | 'rest_api' | 'json_feed' | 'graphql';
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  status: 'connected' | 'disconnected' | 'error' | 'unavailable';
  sourceTotalProducts?: number;
  sourceInStockProducts?: number;
  sourceOutOfStockProducts?: number;
  matchedCount: number;
  ambiguousCount: number;
  variantsCount: number;
  inStockColorsCount: number;
  username?: string;
  password?: string;
  apiKey?: string;
}

export interface SupplierVariant {
  sourceVariantId?: string | number;
  colorName: string;
  normalizedColorName: string;
  sourcePrice: number;
  inStock: boolean;
  stock?: number;
  sourceUpdatedAt?: string;
}

export interface SupplierProductMatch {
  supplierId: string;
  supplierProductId?: string | number;
  sku?: string;
  barcode?: string;
  modelCode?: string;
  normalizedIdentity: string;
  variants: SupplierVariant[];
  confidence: 'exact' | 'high' | 'ambiguous' | 'none';
  matchReason?: string;
  candidates?: { id?: string | number; title: string; price?: number }[];
}

export interface SupplierAdapter {
  id: string;
  name: string;
  fetchCatalog(supplier: Supplier): Promise<{ success: boolean; items: any[]; error?: string }>;
  matchProduct(masterProduct: any, supplierItems: any[], index?: SupplierCatalogIndex): SupplierProductMatch | null;
}

export interface AuditLogEntry {
  id: string;
  action: string;
  details: string;
  actor: string;
  metadata?: any;
  timestamp: string;
}

export interface SupplierCatalogIndex {
  barcodeMap: Map<string, any>;
  skuMap: Map<string, any>;
  idMap: Map<string, any>;
  brandModelMap: Map<string, any[]>;
  items: any[];
}

export interface ProductProfile {
  brand: string;
  series: string;
  modifier: string;
  storage: string | null;
  ram: string | null;
  network: '5G' | '4G' | null;
  partNumber: string | null;
  countryPack: string | null;
  simType: 'dual_sim' | 'single_sim' | null;
  rawText: string;
}

// ============================================================================
// 2. Safe JSON Helpers & Audit Log (Rule 20, 21 - Max 1000 Records, No Secrets)
// ============================================================================

export function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const content = fs.readFileSync(filePath, 'utf-8');
    if (!content.trim()) return fallback;
    return JSON.parse(content) as T;
  } catch {
    return fallback;
  }
}

export function writeJsonFile<T>(filePath: string, data: T): boolean {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tempFile = `${filePath}.tmp.${Date.now()}`;
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tempFile, filePath);
    return true;
  } catch (err) {
    console.error(`[SupplierEngine] Failed to write JSON to ${filePath}:`, err);
    return false;
  }
}

export function recordAuditLog(
  action: string,
  details: string,
  actor: string = 'system',
  metadata?: any
): void {
  try {
    const auditFile = path.join(DATA_DIR, 'audit_logs.json');
    const logs = readJsonFile<AuditLogEntry[]>(auditFile, []);

    // Filter out any sensitive keys from metadata
    let sanitizedMeta = metadata;
    if (metadata && typeof metadata === 'object') {
      const copy = { ...metadata };
      delete copy.password;
      delete copy.token;
      delete copy.secret;
      delete copy.apiKey;
      delete copy.authorization;
      sanitizedMeta = copy;
    }

    const entry: AuditLogEntry = {
      id: `log-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      action,
      details,
      actor,
      metadata: sanitizedMeta,
      timestamp: new Date().toISOString(),
    };

    logs.unshift(entry);

    if (logs.length > 1000) {
      logs.splice(1000);
    }

    writeJsonFile(auditFile, logs);
  } catch {
    // Non-blocking
  }
}

// ============================================================================
// 3. High-Precision Normalizers (Text, Colors, Specs, Part Numbers, Country)
// ============================================================================

export function normalizeText(text?: string | null): string {
  if (!text) return '';
  return text
    .toString()
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, '') // remove zero-width chars
    .replace(/[ي]/g, 'ی')
    .replace(/[ك]/g, 'ک')
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 1776))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 1632))
    .replace(/[\/\-_,.:;+()\[\]{}|\\!@#$%^&*~`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const COLOR_CANONICAL_MAP: Record<string, string> = {
  // Black
  'black': 'مشکی (Black)',
  'مشکی': 'مشکی (Black)',
  'سیاه': 'مشکی (Black)',
  'dark': 'مشکی (Black)',
  'phantom black': 'مشکی (Black)',
  'titanium black': 'مشکی (Black)',
  'midnight': 'مشکی (Black)',
  'space black': 'مشکی (Black)',
  'space gray': 'خاکستری فضایی (Space Gray)',
  'gray': 'خاکستری (Gray)',
  'grey': 'خاکستری (Gray)',
  'طوسی': 'خاکستری (Gray)',
  'خاکستری': 'خاکستری (Gray)',
  // White & Silver
  'white': 'سفید (White)',
  'سفید': 'سفید (White)',
  'starlight': 'سفید استارلایت (Starlight)',
  'silver': 'نقره‌ای (Silver)',
  'نقره ای': 'نقره‌ای (Silver)',
  'نقره‌ای': 'نقره‌ای (Silver)',
  'titanium silver': 'نقره‌ای (Silver)',
  'titanium white': 'سفید تیتانیوم (White Titanium)',
  // Blue
  'blue': 'آبی (Blue)',
  'ابی': 'آبی (Blue)',
  'آبی': 'آبی (Blue)',
  'dark blue': 'آبی تیره (Dark Blue)',
  'deep blue': 'آبی عمیق (Deep Blue)',
  'titanium blue': 'آبی تیتانیوم (Blue Titanium)',
  'sky blue': 'آبی آسمانی (Sky Blue)',
  'sierra blue': 'آبی سیرا (Sierra Blue)',
  'pacific blue': 'آبی پاسیفیک (Pacific Blue)',
  // Gold & Desert
  'gold': 'طلایی (Gold)',
  'طلایی': 'طلایی (Gold)',
  'طلا': 'طلایی (Gold)',
  'desert titanium': 'تیتانیوم صحرایی (Desert Titanium)',
  'desert': 'تیتانیوم صحرایی (Desert Titanium)',
  'صحرایی': 'تیتانیوم صحرایی (Desert Titanium)',
  'رزگلد': 'رز گلد (Rose Gold)',
  'rose gold': 'رز گلد (Rose Gold)',
  // Green
  'green': 'سبز (Green)',
  'سبز': 'سبز (Green)',
  'زیتونی': 'سبز (Green)',
  'olive': 'سبز (Green)',
  'olive green': 'سبز (Green)',
  'awesome olive': 'سبز (Green)',
  'سبز زیتونی': 'سبز (Green)',
  'awesome light green': 'سبز (Green)',
  'سبز لایت': 'سبز (Green)',
  'midnight green': 'سبز نیمه‌شب (Midnight Green)',
  'alpine green': 'سبز آلپاین (Alpine Green)',
  'awesome black': 'مشکی (Black)',
  'awesome white': 'سفید (White)',
  'awesome light blue': 'آبی (Blue)',
  'awesome gray': 'خاکستری (Gray)',
  // Purple & Pink & Red & Yellow
  'purple': 'بنفش (Purple)',
  'بنفش': 'بنفش (Purple)',
  'pink': 'صورتی (Pink)',
  'صورتی': 'صورتی (Pink)',
  'red': 'قرمز (Red)',
  'قرمز': 'قرمز (Red)',
  'yellow': 'زرد (Yellow)',
  'زرد': 'زرد (Yellow)',
  'orange': 'نارنجی (Orange)',
  'نارنجی': 'نارنجی (Orange)',
};

export function normalizeColor(rawColor?: string | null): string {
  if (!rawColor) return '';
  const clean = normalizeText(rawColor);
  for (const [key, canonical] of Object.entries(COLOR_CANONICAL_MAP)) {
    if (clean === key || clean.includes(key)) {
      return canonical;
    }
  }
  return rawColor.trim();
}

export function extractColorFromTitle(title?: string | null): string | null {
  if (!title) return null;
  const clean = normalizeText(title);
  const keys = Object.keys(COLOR_CANONICAL_MAP).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (key.length >= 3 && clean.includes(key)) {
      return COLOR_CANONICAL_MAP[key];
    }
  }
  return null;
}

// ----------------------------------------------------------------------------
// Ultra-Precision Extractors: Storage, RAM, Network, PartNumber, Country/Pack, SIM
// ----------------------------------------------------------------------------

export function extractStorage(text?: string | null): string | null {
  if (!text) return null;
  const raw = String(text);

  // Check direct slash pattern: 128/4, 256/8, 512/12
  const mSlash = raw.match(/\b(32|64|128|256|512|1024)\s*[\/]\s*(2|3|4|6|8|12|16|18|24)\b/i);
  if (mSlash) {
    const s = parseInt(mSlash[1], 10);
    return s < 1024 ? `${s}GB` : '1TB';
  }

  // ترتیب رایج «رم/حافظه»: 8/256 ، 8GB/256GB ، 12GB + 512GB
  const mRamFirst = raw.match(/(?<![\d.])(2|3|4|6|8|10|12|16|18|24)\s*(?:gb|gig|گیگابایت|گیگ)?\s*[\/+]\s*(32|64|128|256|512|1024)(?![\d.])\s*(?:gb|gig|گیگابایت|گیگ)?/i);
  if (mRamFirst) {
    const s = parseInt(mRamFirst[2], 10);
    return s < 1024 ? `${s}GB` : '1TB';
  }
  const mRamFirstTb = raw.match(/(?<![\d.])(2|3|4|6|8|10|12|16|18|24)\s*(?:gb|gig|گیگابایت|گیگ)?\s*[\/+]\s*(\d)\s*(?:tb|ترابایت)/i);
  if (mRamFirstTb) return `${mRamFirstTb[2]}TB`;

  // Check Persian word numbers: دو ترابایت -> 2TB, یک ترابایت -> 1TB
  let t = raw.toLowerCase().replace(/دو\s*ترابایت/g, '2 ترابایت').replace(/یک\s*ترابایت/g, '1 ترابایت');

  // TB
  const mTb = t.match(/(\d+)\s*(?:tb|ترابایت|ترا)(?![a-z\u0600-\u06ff])/i);
  if (mTb) {
    return `${mTb[1]}TB`;
  }

  // GB
  const mGb = t.match(/\b(16|32|64|128|256|512|1024)\s*(?:gb|gig|گیگابایت|گیگ)(?![a-z\u0600-\u06ff])/i);
  if (mGb) {
    const s = parseInt(mGb[1], 10);
    return s < 1024 ? `${s}GB` : '1TB';
  }

  return null;
}

export function extractRam(text?: string | null): string | null {
  if (!text) return null;
  const raw = String(text);

  // 1. Direct slash pattern: 128/4, 256/8, 512/12, 256/8GB
  const mSlash = raw.match(/\b(?:32|64|128|256|512|1024)\s*[\/]\s*(2|3|4|6|8|12|16|18|24)(?:gb|gig|گیگ)?\b/i);
  if (mSlash) {
    return `${parseInt(mSlash[1], 10)}GB`;
  }

  // 1b. ترتیب «رم/حافظه»: 8/256 ، 8GB/256GB ، 12GB+512GB
  const mRamFirst = raw.match(/(?<![\d.])(2|3|4|6|8|10|12|16|18|24)\s*(?:gb|gig|گیگابایت|گیگ)?\s*[\/+]\s*(?:32|64|128|256|512|1024|\d\s*(?:tb|ترابایت))(?![\d.])/i);
  if (mRamFirst) {
    return `${parseInt(mRamFirst[1], 10)}GB`;
  }

  // 2. RAM followed by number: "RAM 12GB", "RAM 8", "رم 8", "رم 12 گیگابایت"
  const mAfter = raw.match(/(?:ram|رم)\s*[:\s-]?\s*(\d+)/i);
  if (mAfter) {
    const val = parseInt(mAfter[1], 10);
    if ([2, 3, 4, 6, 8, 12, 16, 18, 24, 32, 64].includes(val)) {
      return `${val}GB`;
    }
  }

  // 3. Number followed by RAM (excluding storage sizes):
  const mBefore = raw.match(/\b(2|3|4|6|8|12|16|18|24)\s*(?:gig|gb|گیگ|گیگابایت)?\s*(?:ram|رم)(?![a-z\u0600-\u06ff])/i);
  if (mBefore) {
    const val = parseInt(mBefore[1], 10);
    return `${val}GB`;
  }

  return null;
}

export function extractNetwork(text?: string | null): '5G' | '4G' | null {
  if (!text) return null;
  const clean = normalizeText(text);
  if (/\b5g\b|5\s*g\b|۵\s*جی|5جی/i.test(clean)) {
    return '5G';
  }
  if (/\b4g\b|4\s*g\b|lte|۴\s*جی|4جی/i.test(clean)) {
    return '4G';
  }
  return null;
}

export function extractCountryOrPack(text?: string | null): string | null {
  if (!text) return null;
  const clean = normalizeText(text);
  if (/ویتنام|vietnam|vn\b/i.test(clean)) return 'vietnam';
  if (/هند|هندوستان|india|in\b/i.test(clean)) return 'india';
  if (/چین|china|cn\b/i.test(clean)) return 'china';
  if (/اروپا|europe|eu\b/i.test(clean)) return 'europe';
  if (/امارات|دبی|خاورمیانه|uae|me|tra\b/i.test(clean)) return 'uae';
  return null;
}

export function extractPartNumberOrRegion(text?: string | null): string | null {
  if (!text) return null;
  const upper = String(text).toUpperCase();

  // Apple region part numbers: CH/A, ZP/A, ZA/A, LL/A, TH/A, HN/A, JA/A
  const mApple = upper.match(/\b(CH\/A|ZP\/A|ZA\/A|LL\/A|TH\/A|HN\/A|JA\/A|CH|ZP|ZA|LL|TH)\b/);
  if (mApple) {
    const code = mApple[1].replace('/A', '');
    return `${code}/A`;
  }

  // Samsung model codes: SM-A155F, SM-A156B, SM-A556B, SM-S928B
  const mSm = upper.match(/\b(SM-[A-Z0-9]+)\b/);
  if (mSm) {
    return mSm[1];
  }

  // Sony PlayStation CFI codes: CFI-7121, CFI-1200
  const mCfi = upper.match(/\b(CFI-[0-9]+)\b/);
  if (mCfi) {
    return mCfi[1];
  }

  return null;
}

export function extractSimType(text?: string | null): 'dual_sim' | 'single_sim' | null {
  if (!text) return null;
  const clean = normalizeText(text);
  if (/دو\s*سیم|dual\s*sim|2\s*sim|دو\s*سیمکارت/i.test(clean)) {
    return 'dual_sim';
  }
  if (/تک\s*سیم|single\s*sim|1\s*sim|تک\s*سیمکارت/i.test(clean)) {
    return 'single_sim';
  }
  return null;
}

export function extractModelDetails(text?: string | null, brand?: string | null): { series: string; modifier: string } {
  if (!text) return { series: '', modifier: '' };
  const clean = normalizeText(text);

  // Modifiers
  let modifier = '';
  if (clean.includes('pro max') || clean.includes('پرو مکس')) modifier = 'pro max';
  else if (clean.includes('pro plus') || clean.includes('پرو پلاس')) modifier = 'pro plus';
  else if (clean.includes('pro') || clean.includes('پرو')) modifier = 'pro';
  else if (clean.includes('ultra') || clean.includes('اولترا')) modifier = 'ultra';
  else if (clean.includes('plus') || clean.includes('پلاس')) modifier = 'plus';
  else if (clean.includes('mini') || clean.includes('مینی')) modifier = 'mini';
  else if (clean.includes('fe') || clean.includes('اف ای')) modifier = 'fe';
  else if (clean.includes('se') || clean.includes('اس ای')) modifier = 'se';
  else if (clean.includes('digital') || clean.includes('دیجیتال')) modifier = 'digital';
  else if (clean.includes('standard') || clean.includes('استاندارد')) modifier = 'standard';

  // Extract model series (e.g. A15, A16, A17, S24, S25, iPhone 16, Note 13, Wave 10C)
  let series = '';
  // Samsung A or S or M series: a15, a17, s24, s25, m14
  const mSam = clean.match(/\b([asm]\d{1,2})\b/i);
  if (mSam) {
    series = mSam[1].toLowerCase();
  } else {
    // iPhone 11, 12, 13, 14, 15, 16
    const mIphone = clean.match(/\b(?:iphone|آیفون)\s*(\d{1,2})\b/i);
    if (mIphone) {
      series = `iphone ${mIphone[1]}`;
    } else {
      // Xiaomi Note 13, 13C, 14
      const mXiao = clean.match(/\b(?:note|نوت)\s*(\d{1,2})\b/i);
      if (mXiao) {
        series = `note ${mXiao[1]}`;
      } else {
        const m13c = clean.match(/\b(\d{1,2}c)\b/i);
        if (m13c) series = m13c[1];
      }
    }
  }

  // Fallback: word tokens
  if (!series) {
    const words = clean.split(' ').filter((w) => w.length > 2);
    series = words.slice(0, 3).join(' ');
  }

  return { series, modifier };
}

export function normalizeBrand(brand?: string | null): string {
  const norm = normalizeText(brand);
  if (norm.includes('سامسونگ') || norm.includes('samsung')) return 'samsung';
  if (norm.includes('اپل') || norm.includes('apple') || norm.includes('iphone')) return 'apple';
  if (norm.includes('شیائومی') || norm.includes('xiaomi') || norm.includes('redmi') || norm.includes('poco')) return 'xiaomi';
  if (norm.includes('سونی') || norm.includes('sony')) return 'sony';
  if (norm.includes('آنر') || norm.includes('honor')) return 'honor';
  if (norm.includes('هوآوی') || norm.includes('هواوی') || norm.includes('huawei')) return 'huawei';
  if (norm.includes('ایسوس') || norm.includes('asus')) return 'asus';
  return norm;
}

export function buildProductProfile(item: any): ProductProfile {
  const brand = normalizeBrand(item.brand || item.brandEn || item.brand_name || item.brandPersian || '');
  const allText = `${item.title || ''} ${item.name || ''} ${item.persianName || ''} ${item.product_name || ''} ${item.product_name_en || ''} ${item.model || ''} ${item.model_code || ''} ${item.sku || ''}`;

  const { series, modifier } = extractModelDetails(allText, brand);
  const storage = extractStorage(allText) || (item.storage ? extractStorage(item.storage) : null);
  const ram = extractRam(allText) || (item.ram ? extractRam(item.ram) : null);
  const network = extractNetwork(allText);
  const partNumber = extractPartNumberOrRegion(allText) || extractPartNumberOrRegion(item.sku || item.modelCode);
  const countryPack = extractCountryOrPack(allText) || extractCountryOrPack(item.pack || item.country);
  const simType = extractSimType(allText);

  return {
    brand,
    series,
    modifier,
    storage,
    ram,
    network,
    partNumber,
    countryPack,
    simType,
    rawText: allText,
  };
}

/** برای Matchهای مستقیم، وجود تمام مشخصات کلیدیِ موجود در محصول اصلی الزامی است. */
function hasCompleteIdentity(master: ProductProfile, candidate: ProductProfile): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (master.brand && !candidate.brand) missing.push('برند');
  if (master.series && !candidate.series) missing.push('مدل پایه');
  if (master.modifier && !candidate.modifier) missing.push('نسخه مدل');
  if (master.storage && !candidate.storage) missing.push('حافظه');
  if (master.ram && !candidate.ram) missing.push('رم');
  if (master.network && !candidate.network) missing.push('شبکه');
  if (master.partNumber && !candidate.partNumber) missing.push('پارت نامبر/کد مدل');
  if (master.countryPack && !candidate.countryPack) missing.push('کشور سازنده/پک');
  if (master.simType && !candidate.simType) missing.push('نوع سیم‌کارت');
  return { ok: missing.length === 0, missing };
}

export function validateProductCompatibility(
  master: ProductProfile,
  candidate: ProductProfile
): { compatible: boolean; reason?: string } {
  // 0. Accessory vs Device validation (Do not match cases, glass, LCD, or parts with actual phones)
  const accessoryPattern = /(?:کاور|قاب|گلس|باندل|پک\s*\d+|محافظ\s*صفحه|lcd|سرویس\s*پک|service\s*pack|شارژر|کابل|هندزفری|باتری|روکاری|buzzer|module|tray|\bcase\b|\bcover\b|\bglass\b)/i;
  const isMasterPhone = Boolean(master.series || master.storage || master.ram);
  if (isMasterPhone && accessoryPattern.test(candidate.rawText || "")) {
    return { compatible: false, reason: "کالای تطبیقی لوازم جانبی یا قطعه یدکی است و نه خود دستگاه" };
  }
  // 1. Brand validation
  if (master.brand && candidate.brand) {
    if (master.brand !== candidate.brand) {
      return { compatible: false, reason: `عدم تطابق برند: ${master.brand} با ${candidate.brand}` };
    }
  }

  // 2. Model Series validation (e.g. A15 vs A16 vs A17)
  if (master.series && candidate.series) {
    if (master.series !== candidate.series) {
      return { compatible: false, reason: `عدم تطابق مدل پایه: ${master.series} با ${candidate.series}` };
    }
  }

  // 3. Model Modifier validation (e.g. Ultra vs Plus vs Pro vs Pro Max)
  if (master.modifier !== candidate.modifier) {
    return { compatible: false, reason: `عدم تطابق نسخه مدل: ${master.modifier || 'استاندارد'} با ${candidate.modifier || 'استاندارد'}` };
  }

  // 4. Storage validation (e.g. 128GB vs 256GB)
  if (master.storage && candidate.storage) {
    if (master.storage.toLowerCase() !== candidate.storage.toLowerCase()) {
      return { compatible: false, reason: `عدم تطابق ظرفیت حافظه: ${master.storage} با ${candidate.storage}` };
    }
  }

  // 5. RAM validation (e.g. 4GB vs 6GB vs 8GB)
  if (master.ram && candidate.ram) {
    if (master.ram.toLowerCase() !== candidate.ram.toLowerCase()) {
      return { compatible: false, reason: `عدم تطابق حافظه رم: ${master.ram} با ${candidate.ram}` };
    }
  }

  // 6. Network generation validation (4G vs 5G)
  if (master.network && candidate.network) {
    if (master.network !== candidate.network) {
      return { compatible: false, reason: `عدم تطابق شبکه ارتباطی: ${master.network} با ${candidate.network}` };
    }
  }

  // 7. Part Number / Region validation (CH/A vs ZP/A vs LL/A or SM-A155F vs SM-A156B)
  if (master.partNumber && candidate.partNumber) {
    if (master.partNumber.toUpperCase() !== candidate.partNumber.toUpperCase()) {
      return { compatible: false, reason: `عدم تطابق پارت نامبر/کد مدل: ${master.partNumber} با ${candidate.partNumber}` };
    }
  }

  // 8. Country of Origin / Pack validation (Vietnam vs India vs China)
  if (master.countryPack && candidate.countryPack) {
    if (master.countryPack.toLowerCase() !== candidate.countryPack.toLowerCase()) {
      return { compatible: false, reason: `عدم تطابق کشور سازنده/پک: ${master.countryPack} با ${candidate.countryPack}` };
    }
  }

  // 9. SIM Type validation (Single SIM vs Dual SIM)
  if (master.simType && candidate.simType) {
    if (master.simType !== candidate.simType) {
      return { compatible: false, reason: `عدم تطابق تعداد سیم‌کارت: ${master.simType} با ${candidate.simType}` };
    }
  }

  return { compatible: true };
}

// ============================================================================
// 4. HTTP Fetcher with Independent Timeout (Rule 26)
// ============================================================================

function fetchJson<T>(url: string, timeoutMs: number = 5000): Promise<{ data: T | null; error?: string }> {
  return new Promise((resolve) => {
    try {
      const parsedUrl = new URL(url);
      const isHttps = parsedUrl.protocol === 'https:';
      const client = isHttps ? https : http;

      const req = client.get(
        url,
        {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            Accept: 'application/json, text/plain, */*',
          },
          timeout: timeoutMs,
        },
        (res) => {
          if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
            res.resume();
            return resolve({
              data: null,
              error: `HTTP ${res.statusCode} ${res.statusMessage || ''}`,
            });
          }

          let raw = '';
          res.setEncoding('utf-8');
          res.on('data', (chunk) => (raw += chunk));
          res.on('end', () => {
            try {
              const parsed = JSON.parse(raw);
              resolve({ data: parsed });
            } catch (err: any) {
              resolve({ data: null, error: `پاسخ نامعتبر JSON: ${err.message}` });
            }
          });
        }
      );

      req.on('timeout', () => {
        req.destroy();
        resolve({ data: null, error: `اتصال به تأمین‌کننده به پایان مهلت (${timeoutMs}ms) رسید` });
      });

      req.on('error', (err) => {
        resolve({ data: null, error: err.message || 'خطا در ارتباط شبکه' });
      });
    } catch (err: any) {
      resolve({ data: null, error: err.message || 'نشانی نامعتبر' });
    }
  });
}

// ============================================================================
// 5. Suppliers Management (Rule 3 & 13)
// ============================================================================

const DEFAULT_SUPPLIERS: Supplier[] = [
  {
    id: 'kasra',
    name: 'کسری پلاس (Kasra Plus)',
    enabled: true,
    baseUrl: 'https://api.kasrapars.ir/api/web/v10/product/index?per-page=100',
    connectionType: 'api_feed',
    lastSyncAt: null,
    lastSuccessAt: null,
    lastError: null,
    status: 'connected',
    sourceTotalProducts: 0,
    sourceInStockProducts: 0,
    sourceOutOfStockProducts: 0,
    matchedCount: 0,
    ambiguousCount: 0,
    variantsCount: 0,
    inStockColorsCount: 0,
  },
  {
    id: 'hamrahtel',
    name: 'همراه تل (Hamrah Tel)',
    enabled: true,
    baseUrl: 'https://core-api.hamrahtel.com/graphql/',
    connectionType: 'graphql',
    lastSyncAt: null,
    lastSuccessAt: null,
    lastError: null,
    status: 'connected',
    sourceTotalProducts: 0,
    sourceInStockProducts: 0,
    sourceOutOfStockProducts: 0,
    matchedCount: 0,
    ambiguousCount: 0,
    variantsCount: 0,
    inStockColorsCount: 0,
  },
  {
    id: 'ehadish',
    name: 'هدیش (Ehadish)',
    enabled: true,
    baseUrl: 'https://www.ehadish.com/',
    connectionType: 'api_feed',
    lastSyncAt: null,
    lastSuccessAt: null,
    lastError: null,
    status: 'connected',
    sourceTotalProducts: 64,
    sourceInStockProducts: 17,
    sourceOutOfStockProducts: 47,
    matchedCount: 0,
    ambiguousCount: 0,
    variantsCount: 0,
    inStockColorsCount: 0,
  },
];

export function getSuppliersList(): Supplier[] {
  const filePath = path.join(DATA_DIR, 'suppliers.json');
  let sups = readJsonFile<Supplier[]>(filePath, []);
  if (!Array.isArray(sups) || sups.length === 0) {
    saveSuppliersList(DEFAULT_SUPPLIERS);
    return DEFAULT_SUPPLIERS;
  }
  let modified = false;
  for (const def of DEFAULT_SUPPLIERS) {
    if (!sups.some((s) => s.id === def.id)) {
      sups.push({ ...def });
      modified = true;
    }
  }
  if (modified) {
    saveSuppliersList(sups);
  }
  return sups;
}

export function saveSuppliersList(suppliers: Supplier[]): void {
  const filePath = path.join(DATA_DIR, 'suppliers.json');
  writeJsonFile(filePath, suppliers);
}

// ============================================================================
// 6. Universal Supplier Adapter (Ultra-Precise Matching)
// ============================================================================

function buildMatch(
  masterProduct: any,
  sourceItem: any,
  supplierId: string,
  confidence: 'exact' | 'high' | 'ambiguous',
  reason?: string
): SupplierProductMatch {
  const variants: SupplierVariant[] = [];

  const rawPrice = Number(
    sourceItem.price ||
      sourceItem.sell_price ||
      sourceItem.sourcePrice ||
      (sourceItem.product_variants && sourceItem.product_variants[0]?.price) ||
      0
  );

  // If item has structured color variants
  if (Array.isArray(sourceItem.variants) && sourceItem.variants.length > 0) {
    for (const v of sourceItem.variants) {
      const colName = v.color || v.color_name || v.name;
      if (!colName) continue;
      const colPrice = Number(v.price || rawPrice);
      const isStock = v.stock !== undefined ? Number(v.stock) > 0 : (v.inStock !== undefined ? Boolean(v.inStock) : true);
      variants.push({
        sourceVariantId: v.id,
        colorName: colName,
        normalizedColorName: normalizeColor(colName),
        sourcePrice: colPrice,
        inStock: isStock,
        sourceUpdatedAt: new Date().toISOString(),
      });
    }
  } else if (Array.isArray(sourceItem.colors) && sourceItem.colors.length > 0) {
    for (const col of sourceItem.colors) {
      const colName = typeof col === 'string' ? col : col.name || col.title;
      if (!colName) continue;
      const colPrice = typeof col === 'object' && col.price ? Number(col.price) : rawPrice;
      const isStock = typeof col === 'object' && col.stock !== undefined ? Number(col.stock) > 0 : true;
      variants.push({
        colorName: colName,
        normalizedColorName: normalizeColor(colName),
        sourcePrice: colPrice,
        inStock: isStock,
        sourceUpdatedAt: new Date().toISOString(),
      });
    }
  } else if (rawPrice > 0) {
    const detected = normalizeColor(sourceItem.title || sourceItem.name || sourceItem.persianName);
    variants.push({
      colorName: detected || 'پیش‌فرض',
      normalizedColorName: detected || 'پیش‌فرض',
      sourcePrice: rawPrice,
      inStock: sourceItem.stock !== undefined ? Number(sourceItem.stock) > 0 : true,
      sourceUpdatedAt: new Date().toISOString(),
    });
  }

  return {
    supplierId,
    supplierProductId: sourceItem.id || sourceItem.product_id,
    sku: sourceItem.sku,
    barcode: sourceItem.barcode || sourceItem.gtin,
    modelCode: sourceItem.model_code,
    normalizedIdentity: normalizeText(sourceItem.title || sourceItem.name || sourceItem.product_name),
    variants,
    confidence,
    matchReason: reason,
  };
}

export const UniversalSupplierAdapter: SupplierAdapter = {
  id: 'universal',
  name: 'تأمین‌کننده عمومی استاندارد',

  async fetchCatalog(supplier: Supplier): Promise<{ success: boolean; items: any[]; error?: string }> {
    if (!supplier.enabled) {
      return { success: false, items: [], error: 'تأمین‌کننده غیرفعال است' };
    }
    const res = await fetchJson<any>(supplier.baseUrl, 5000);
    if (!res.data) {
      return { success: false, items: [], error: res.error || `خطا در استعلام از ${supplier.name}` };
    }

    let items: any[] = [];
    if (res.data.dataProvider && Array.isArray(res.data.dataProvider.items)) {
      items = res.data.dataProvider.items;
    } else if (Array.isArray(res.data.items)) {
      items = res.data.items;
    } else if (Array.isArray(res.data.products)) {
      items = res.data.products;
    } else if (Array.isArray(res.data.data)) {
      items = res.data.data;
    } else if (Array.isArray(res.data)) {
      items = res.data;
    }

    return { success: true, items };
  },

  matchProduct(
    masterProduct: any,
    supplierItems: any[],
    index?: SupplierCatalogIndex
  ): SupplierProductMatch | null {
    if (!masterProduct || !supplierItems || supplierItems.length === 0) return null;

    const masterProfile = buildProductProfile(masterProduct);
    const masterBarcode = masterProduct.barcode || masterProduct.gtin || masterProduct.ean;
    const masterSku = masterProduct.sku || masterProduct.modelCode;

    // 1. Direct Barcode Match from Index O(1) + Spec Validation
    if (index && masterBarcode) {
      const match = index.barcodeMap.get(String(masterBarcode).trim());
      if (match) {
        const candProfile = buildProductProfile(match);
        const check = validateProductCompatibility(masterProfile, candProfile);
        if (check.compatible && hasCompleteIdentity(masterProfile, candProfile).ok) {
          return buildMatch(masterProduct, match, this.id, 'exact', 'تطبیق قطعی با بارکد و مشخصات کامل');
        }
      }
    }

    // 2. Direct SKU Match from Index O(1) + Spec Validation
    if (index && masterSku) {
      const match = index.skuMap.get(String(masterSku).trim().toLowerCase());
      if (match) {
        const candProfile = buildProductProfile(match);
        const check = validateProductCompatibility(masterProfile, candProfile);
        if (check.compatible && hasCompleteIdentity(masterProfile, candProfile).ok) {
          return buildMatch(masterProduct, match, this.id, 'exact', 'تطبیق قطعی با SKU و مشخصات کامل');
        }
      }
    }

    // 3. Mapped Supplier Product ID O(1) + Spec Validation
    const prefixId =
      this.id === 'kasra' ? 'prod-ks-' : this.id === 'hamrahtel' ? 'prod-ht-' : this.id === 'ehadish' ? 'prod-eh-' : '';
    const mappedSupId =
      masterProduct.supplierMatches?.[this.id]?.supplierProductId ||
      (masterProduct.sourceSupplierId === this.id ? masterProduct.sourceProductId : undefined) ||
      (prefixId && String(masterProduct.id).startsWith(prefixId) ? String(masterProduct.id).replace(prefixId, '') : undefined);

    if (index && mappedSupId) {
      const match = index.idMap.get(String(mappedSupId).trim());
      if (match) {
        return buildMatch(masterProduct, match, this.id, 'exact', 'تطبیق قطعی با شناسه متصل تأمین‌کننده');
      }
    }

    // 4. تطبیق چندمشخصه — فقط وقتی «قطعی» است که تمام مشخصات کلیدی پازل کالا در کالای تأمین‌کننده هم صراحتاً آمده و برابر باشد.
    // اگر تأمین‌کننده مثلاً حافظه یا کشور سازنده را ننوشته باشد، کالا «مبهم» می‌شود و قیمتش اعمال نمی‌شود.
    const candidates: any[] = [];
    const pool = index ? index.items : supplierItems;
    const titleOf = (it: any) => String(it.title || it.name || it.product_name_en || it.product_name || it.persianName || '').slice(0, 160);

    for (const item of pool) {
      const candProfile = buildProductProfile(item);
      const check = validateProductCompatibility(masterProfile, candProfile);
      if (check.compatible) {
        const missing: string[] = [];
        if (masterProfile.brand && !candProfile.brand) missing.push('برند');
        if (masterProfile.series && !candProfile.series) missing.push('مدل پایه');
        if (masterProfile.storage && !candProfile.storage) missing.push('حافظه');
        if (masterProfile.ram && !candProfile.ram) missing.push('رم');
        if (masterProfile.countryPack && !candProfile.countryPack) missing.push('کشور سازنده');
        candidates.push({ item, profile: candProfile, missing });
      }
    }
    const asList = (cs: any[]) =>
      cs.slice(0, 5).map((c) => {
        let col = c.item.color || c.item.color_name;
        const variantItems: { name: string; price: number; color?: string; stock?: number }[] = [];
        if (Array.isArray(c.item.variants) && c.item.variants.length > 0) {
          for (const v of c.item.variants) {
            const vCol = v.color || v.color_name || v.name || v.title || '';
            const vPr = Number(v.price || v.sourcePrice || v.sell_price || 0);
            if (vCol) {
              variantItems.push({ name: vCol, price: vPr, stock: v.stock });
            }
          }
          if (!col && variantItems.length > 0) {
            col = variantItems.map((v) => v.name).join('، ');
          }
        }
        if (!col) col = extractColorFromTitle(titleOf(c.item)) || 'پیش‌فرض / نامشخص';
        const pr = Number(c.item.price || c.item.sell_price || c.item.sourcePrice || (c.item.variants && c.item.variants[0]?.price) || 0) || undefined;
        return {
          id: c.item.id,
          title: titleOf(c.item),
          price: pr,
          color: col,
          variants: variantItems,
        };
      });
    const strong = candidates.filter((c) => c.missing.length === 0);

    if (strong.length === 1) {
      return buildMatch(masterProduct, strong[0].item, this.id, 'high', 'تطبیق مشخصات کامل (مدل، رم، حافظه، شبکه، پارت نامبر و کشور سازنده)');
    }
    if (strong.length > 1) {
      const exactPart = strong.filter((c) => masterProfile.partNumber && c.profile.partNumber === masterProfile.partNumber);
      if (exactPart.length === 1) return buildMatch(masterProduct, exactPart[0].item, this.id, 'high', 'تطبیق دقیق پارت نامبر');
      const m = buildMatch(masterProduct, strong[0].item, this.id, 'ambiguous', `تطبیق مبهم بین ${strong.length} کالای مشابه در تأمین‌کننده`);
      m.candidates = asList(strong);
      return m;
    }
    if (candidates.length > 0) {
      const miss = [...new Set(candidates.flatMap((c) => c.missing))].join('، ');
      const m = buildMatch(masterProduct, candidates[0].item, this.id, 'ambiguous', `مشخصات کالای تأمین‌کننده کامل نیست (ننوشته: ${miss})؛ برای اطمینان قیمت اعمال نشد`);
      m.candidates = asList(candidates);
      return m;
    }

    return null;
  },
};

export const KasraAdapter: SupplierAdapter = {
  ...UniversalSupplierAdapter,
  id: 'kasra',
  name: 'کسری پلاس (Kasra Plus)',
  async fetchCatalog(supplier: Supplier): Promise<{ success: boolean; items: any[]; error?: string }> {
    // Kasra uses page-based pagination. Fetch the complete catalog instead of silently
    // syncing only the first 100 records. We keep a hard page cap and stop on repeated
    // pages so a broken/ignored pagination parameter cannot create an infinite loop.
    const PAGE_SIZE = 100;
    const MAX_PAGES = 1000;
    const allItems: any[] = [];
    const seenIds = new Set<string>();
    let page = 1;

    while (page <= MAX_PAGES) {
      const base = new URL(supplier.baseUrl);
      base.searchParams.set('per-page', String(PAGE_SIZE));
      base.searchParams.set('page', String(page));

      const res = await fetchJson<any>(base.toString(), 8000);
      if (!res.data) {
        return {
          success: false,
          items: [],
          error: res.error || `خطا در دریافت صفحه ${page} از ${supplier.name}`,
        };
      }

      let pageItems: any[] = [];
      if (res.data.dataProvider && Array.isArray(res.data.dataProvider.items)) {
        pageItems = res.data.dataProvider.items;
      } else if (Array.isArray(res.data.items)) {
        pageItems = res.data.items;
      } else if (Array.isArray(res.data.products)) {
        pageItems = res.data.products;
      } else if (Array.isArray(res.data.data)) {
        pageItems = res.data.data;
      } else if (Array.isArray(res.data)) {
        pageItems = res.data;
      }

      if (pageItems.length === 0) break;

      let addedThisPage = 0;
      for (const item of pageItems) {
        const key = String(item?.id ?? item?.product_id ?? item?.sku ?? JSON.stringify(item));
        if (!seenIds.has(key)) {
          seenIds.add(key);
          allItems.push(item);
          addedThisPage++;
        }
      }

      // If the source ignores `page` and keeps returning the same page, stop safely.
      if (addedThisPage === 0) break;

      // A short page is the normal end-of-catalog signal.
      if (pageItems.length < PAGE_SIZE) break;
      page++;
    }

    if (page > MAX_PAGES) {
      return {
        success: false,
        items: [],
        error: `تعداد صفحات کاتالوگ کسری از سقف ایمن ${MAX_PAGES} صفحه بیشتر شد؛ همگام‌سازی متوقف شد تا داده ناقص جایگزین نشود.`,
      };
    }

    const normalizedItems = allItems.map((it: any) => {
      // موجودی از اطلاعات ارسالی وب‌سرویس تأمین‌کننده سنجیده می‌شود
      const variantsArr = [...(Array.isArray(it.variants) ? it.variants : []), ...(Array.isArray(it.colors) ? it.colors : [])];
      const anyVariantStock = variantsArr.some((v: any) => v && (v.inStock === true || Number(v.stock) > 0));
      const isUnavailable = it.no_longer_available === true || it.is_available === false || it.is_available === 0 || it.site_visible === 0;
      const numericStock = it.stock !== undefined && it.stock !== null && it.stock !== '' ? Number(it.stock) : undefined;
      const hasNumericStock = numericStock !== undefined && !Number.isNaN(numericStock);
      const price = Number(it.price || it.sell_price || it.sourcePrice || 0);

      const isVisible: boolean = hasNumericStock
        ? (numericStock as number) > 0 && !isUnavailable
        : anyVariantStock
          ? !isUnavailable
          : (it.site_visible !== 0 && !isUnavailable);

      const name = it.product_name || it.product_name_en || it.short_name || it.name || it.title || '';
      const nameEn = it.product_name_en || it.name_en || '';
      const image = it.src || it.image || '';

      return {
        ...it,
        id: it.id,
        name,
        title: name,
        persianName: name,
        nameEn,
        inStock: isVisible,
        stock: hasNumericStock ? numericStock : isVisible ? (Number(it.stock) || 10) : 0,
        is_available: !isUnavailable,
        site_visible: it.site_visible !== undefined ? it.site_visible : isVisible ? 1 : 0,
        price,
        image,
        images: image ? [image] : [],
        supplierId: 'kasra',
        supplierName: 'کسری پلاس (Kasra Plus)',
      };
    });

    return { success: true, items: normalizedItems };
  },
};

let hamrahTelTokenCache: { token: string; expiresAt: number } | null = null;

export function clearHamrahTelTokenCache() {
  hamrahTelTokenCache = null;
}

async function getHamrahTelAuthToken(supplier?: Supplier): Promise<string | null> {
  const now = Date.now();
  if (hamrahTelTokenCache && hamrahTelTokenCache.expiresAt > now + 60000) {
    return hamrahTelTokenCache.token;
  }

  const url = supplier?.baseUrl && supplier.baseUrl.includes('graphql') ? supplier.baseUrl : 'https://core-api.hamrahtel.com/graphql/';
  const query = `
    mutation TokenCreate($phoneNumber: String!, $password: String!) {
      tokenCreate(phoneNumber: $phoneNumber, password: $password) {
        token
        errors {
          message
        }
      }
    }
  `;
  const phoneNumber = supplier?.username || process.env.HAMRAHTEL_PHONE;
  const password = supplier?.password || process.env.HAMRAHTEL_PASSWORD;
  if (!phoneNumber || !password) return null;
  const body = JSON.stringify({
    query,
    variables: { phoneNumber, password },
  });

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      body,
    });
    const data = (await res.json()) as any;
    const token = data?.data?.tokenCreate?.token;
    if (token) {
      hamrahTelTokenCache = { token, expiresAt: now + 7 * 24 * 3600 * 1000 };
      return token;
    }
  } catch (err) {
    console.error('Hamrah Tel Auth Error:', err);
  }
  return null;
}

export const HamrahTelAdapter: SupplierAdapter = {
  ...UniversalSupplierAdapter,
  id: 'hamrahtel',
  name: 'همراه تل (Hamrah Tel)',
  async fetchCatalog(supplier: Supplier) {
    if (!supplier.enabled) {
      return { success: false, items: [], error: 'تأمین‌کننده غیرفعال است' };
    }

    try {
      const token = await getHamrahTelAuthToken(supplier);
      if (!token) {
        return {
          success: false,
          items: [],
          error: 'خطا در احراز هویت با نام کاربری و رمز عبور همراه تل',
        };
      }

            // Fetch mobile category (140+ phones) + root products + targeted searches for current store products
      const queryCombined = `
        query GetCombinedProducts($first: Int!) {
          mobileCategory: category(slug: "mobile") {
            products(first: $first) {
              edges {
                node {
                  id
                  name
                  slug
                  thumbnail {
                    url
                  }
                  variants {
                    id
                    name
                    sku
                    pricing {
                      price {
                        gross {
                          amount
                          currency
                        }
                      }
                    }
                    quantityAvailable
                  }
                }
              }
            }
          }
          rootProducts: products(first: $first) {
            edges {
              node {
                id
                name
                slug
                thumbnail {
                  url
                }
                variants {
                  id
                  name
                  sku
                  pricing {
                    price {
                      gross {
                        amount
                        currency
                      }
                    }
                  }
                  quantityAvailable
                }
              }
            }
          }
        }
      `;

      const res = await fetch('https://core-api.hamrahtel.com/graphql/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `JWT ${token}`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        },
        body: JSON.stringify({ query: queryCombined, variables: { first: 100 } }),
      });

      const data = (await res.json()) as any;
      const mobileEdges = data?.data?.mobileCategory?.products?.edges || [];
      const rootEdges = data?.data?.rootProducts?.edges || [];
      const nodeMap = new Map<string, any>();
      for (const e of [...mobileEdges, ...rootEdges]) {
        if (e?.node?.id) nodeMap.set(e.node.id, e.node);
      }

      // If main query yielded products, no need for hundreds of slow individual queries
      if (nodeMap.size === 0) {
        try {
          const storeProducts = readJsonFile<any[]>(path.join(DATA_DIR, 'products.json'), []);
          for (const p of storeProducts.slice(0, 15)) {
            const searchKey = p.model || (p.name || "").match(/\b(A\d+|S\d+|iPhone\s*\d+|Note\s*\d+)/i)?.[0];
          if (searchKey) {
            const searchQuery = `
              query SearchP($search: String!) {
                products(first: 10, filter: { search: $search }) {
                  edges {
                    node {
                      id
                      name
                      slug
                      variants {
                        id
                        name
                        sku
                        pricing {
                          price {
                            gross {
                              amount
                              currency
                            }
                          }
                        }
                        quantityAvailable
                      }
                    }
                  }
                }
              }
            `;
            const sRes = await fetch('https://core-api.hamrahtel.com/graphql/', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `JWT ${token}`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
              },
              body: JSON.stringify({ query: searchQuery, variables: { search: searchKey } }),
            });
            const sData = (await sRes.json()) as any;
            for (const se of sData?.data?.products?.edges || []) {
              if (se?.node?.id) nodeMap.set(se.node.id, se.node);
            }
          }
        }
      } catch (err) {
        console.warn("Targeted Hamrah Tel search error:", err);
      }
    }

      const edges = Array.from(nodeMap.values()).map(n => ({ node: n }));
      const items: any[] = [];

      for (const edge of edges) {
        const node = edge.node;
        if (!node) continue;

        const variants = (node.variants || []).map((v: any) => {
          let rawPrice = v.pricing?.price?.gross?.amount ? Math.round(Number(v.pricing.price.gross.amount)) : 0;
          // In Hamrah Tel, phone prices over 20,000,000 are in Rials -> convert to Tomans
          if (rawPrice > 20000000) {
            rawPrice = Math.round(rawPrice / 10);
          }
          const stock = Number(v.quantityAvailable || 0);
          return {
            id: v.id,
            name: v.name || 'پیش‌فرض',
            color: v.name || 'پیش‌فرض',
            color_name: v.name || 'پیش‌فرض',
            sku: v.sku,
            price: rawPrice,
            stock,
            inStock: stock > 0,
          };
        });

        const activeVariant = variants.find((v: any) => v.price > 0 && v.inStock) || variants[0];
        const defaultPrice = activeVariant ? activeVariant.price : 0;
        const totalStock = variants.reduce((sum: number, v: any) => sum + (v.stock || 0), 0);

        const img = node.thumbnail?.url || '';
        items.push({
          id: node.id,
          name: node.name,
          title: node.name,
          persianName: node.name,
          slug: node.slug,
          sku: node.variants?.[0]?.sku,
          price: defaultPrice,
          stock: totalStock,
          image: img,
          images: img ? [img] : [],
          variants,
        });
      }

      return { success: true, items };
    } catch (err: any) {
      return {
        success: false,
        items: [],
        error: `خطا در دریافت کاتالوگ همراه تل: ${err?.message || err}`,
      };
    }
  },
};

export const EhadishAdapter: SupplierAdapter = {
  ...UniversalSupplierAdapter,
  id: 'ehadish',
  name: 'هدیش (Ehadish)',
  async fetchCatalog(supplier: Supplier): Promise<{ success: boolean; items: any[]; error?: string }> {
    try {
      const allProducts = readJsonFile<any[]>(path.join(DATA_DIR, 'products.json'), []);
      const ehadishItems = allProducts.filter(
        (p) => p.sourceSupplier === 'ehadish' || String(p.id).startsWith('prod-eh-') || p.supplierMatches?.ehadish
      );

      const normalizedItems = ehadishItems.map((p) => {
        const numId = String(p.supplierMatches?.ehadish?.supplierProductId || p.id).replace('prod-eh-', '');
        const rawVariants = Array.isArray(p.variants) && p.variants[0]?.options ? p.variants[0].options : Array.isArray(p.colors) ? p.colors : [];
        return {
          id: numId,
          sku: numId,
          name: p.name,
          title: p.title || p.name,
          persianName: p.persianName || p.name,
          brand: p.brand,
          category: p.category,
          price: p.price,
          stock: p.stock || 15,
          inStock: p.inStock !== false,
          image: p.image,
          images: p.images || [p.image],
          supplierId: 'ehadish',
          supplierName: 'هدیش (Ehadish)',
          variants: rawVariants.map((c: any) => ({
            id: c.id,
            name: c.name,
            color: c.name,
            colorName: c.name,
            colorCode: c.colorCode,
            price: c.price || p.price,
            stock: c.stock || 10,
            inStock: c.inStock !== false,
          })),
        };
      });

      return { success: true, items: normalizedItems };
    } catch (err: any) {
      return {
        success: false,
        items: [],
        error: `خطا در کاتالوگ هدیش: ${err?.message || err}`,
      };
    }
  },
};

const ADAPTERS: Record<string, SupplierAdapter> = {
  kasra: KasraAdapter,
  hamrahtel: HamrahTelAdapter,
  ehadish: EhadishAdapter,
};

export function registerSupplierAdapter(adapter: SupplierAdapter) {
  ADAPTERS[adapter.id] = adapter;
}

// ============================================================================
// 7. Core Multi-Supplier Sync & Pricing Engine
// ============================================================================

let isSyncRunning = false;

export async function executeMultiSupplierSync(
  onUpdateNotify?: (() => void) | any
): Promise<{
  success: boolean;
  message: string;
  updatedMasterProducts: number;
  supplierStats: Record<string, any>;
  timestamp: string;
}> {
  // Concurrency Guard: Mutex Lock
  if (isSyncRunning) {
    return {
      success: false,
      message: 'همگام‌سازی تأمین‌کنندگان در حال حاضر در حال اجراست؛ لطفاً شکیبا باشید.',
      updatedMasterProducts: 0,
      supplierStats: {},
      timestamp: new Date().toISOString(),
    };
  }

  isSyncRunning = true;
  const nowIso = new Date().toISOString();

  try {
    const suppliers = getSuppliersList();
    const enabledSuppliers = suppliers.filter((s) => s.enabled);
    const productsPath = path.join(DATA_DIR, 'products.json');
    const masterProducts: any[] = readJsonFile<any[]>(productsPath, []);

    // Read approved markup percentage from settings (Defaults to 5%)
    const settingsPath = path.join(DATA_DIR, 'settings.json');
    const settings = readJsonFile<any>(settingsPath, {});
    const approvedMarkupPercent = Number(settings.supplierMarkupPercent ?? 5);
    const markupRate = approvedMarkupPercent / 100;

    // حفاظ جهش قیمت: اگر قیمت جدید بیش از این درصد با قیمت فعلی سایت فرق کند، اعمال نمی‌شود و برای بررسی مدیر ثبت می‌شود.
    // مقدار از settings.priceJumpGuardPercent خوانده می‌شود (پیش‌فرض ۳۰؛ ۰ = غیرفعال).
    const jumpGuardPercent = Number(settings.priceJumpGuardPercent ?? 30);
    const jumpPercentOf = (oldPrice: any, newPrice: number): number => {
      const o = Number(oldPrice);
      if (!(o > 0) || !(newPrice > 0)) return 0;
      return (Math.abs(newPrice - o) / o) * 100;
    };
    const isSuspiciousJump = (oldPrice: any, newPrice: number, approvedSource: any, newSource: number): boolean => {
      if (!(jumpGuardPercent > 0)) return false;
      if (approvedSource !== undefined && approvedSource !== null && Number(approvedSource) === newSource) return false; // مدیر همین قیمت را تأیید کرده
      return jumpPercentOf(oldPrice, newPrice) > jumpGuardPercent;
    };

    const supplierCatalogs: Record<string, any[]> = {};
    const supplierStats: Record<string, any> = {};

    // 1. Fetch catalogs from all enabled suppliers in PARALLEL
    await Promise.all(
      enabledSuppliers.map(async (sup) => {
        const adapter = ADAPTERS[sup.id] || { ...UniversalSupplierAdapter, id: sup.id, name: sup.name };
        sup.lastSyncAt = nowIso;

        try {
          const fetchRes = await adapter.fetchCatalog(sup);
          if (fetchRes.success && Array.isArray(fetchRes.items)) {
            // A successful HTTP response with an empty catalog is not safe evidence
            // that the supplier has zero products. Treat it as an unavailable feed so
            // a transient/auth/pagination failure cannot turn every matched product
            // into out-of-stock.
            if (fetchRes.items.length === 0) {
              sup.status = 'unavailable';
              sup.lastError = 'کاتالوگ تأمین‌کننده خالی دریافت شد؛ برای جلوگیری از صفر/ناموجود شدن کاذب، وضعیت قبلی حفظ شد.';
              supplierCatalogs[sup.id] = [];
            } else {
              sup.status = 'connected';
              sup.lastSuccessAt = nowIso;
              sup.lastError = null;
              supplierCatalogs[sup.id] = fetchRes.items;
            }
          } else {
            sup.status = 'unavailable';
            sup.lastError = fetchRes.error || 'پاسخ نامعتبر از تأمین‌کننده';
            supplierCatalogs[sup.id] = [];
          }
        } catch (err: any) {
          sup.status = 'error';
          sup.lastError = err.message || 'خطا در برقراری ارتباط';
          supplierCatalogs[sup.id] = [];
        }

        sup.matchedCount = 0;
        sup.ambiguousCount = 0;
        sup.variantsCount = 0;
        sup.inStockColorsCount = 0;

        const catItems = supplierCatalogs[sup.id] || [];
        const itemInStock = (it: any) => {
          if (!it || typeof it !== 'object') return false;
          if (it.no_longer_available === true || it.is_available === false || it.is_available === 0 || it.site_visible === 0) return false;
          if (it.inStock === true) return true;
          if (it.stock !== undefined && it.stock !== null && it.stock !== '' && Number(it.stock) > 0) return true;
          const variants = [...(Array.isArray(it.variants) ? it.variants : []), ...(Array.isArray(it.colors) ? it.colors : [])];
          if (variants.length > 0) {
            return variants.some((v: any) => v && (v.inStock === true || Number(v.stock) > 0 || v.is_available === true || v.is_available === 1));
          }
          if (Number(it.price || it.sell_price || it.sourcePrice || 0) > 0) {
            return true;
          }
          if (it.site_visible === 1 || it.site_visible === true) {
            return true;
          }
          return false;
        };
        const fetchedOk = sup.status === 'connected';
        // اگر دریافت کاتالوگ ناموفق بود، آمار قبلی حفظ می‌شود (به‌جای صفر شدن)
        const srcTotal = fetchedOk ? catItems.length : sup.sourceTotalProducts ?? 0;
        const srcInStock = fetchedOk ? catItems.filter(itemInStock).length : sup.sourceInStockProducts ?? 0;
        const srcOutOfStock = Math.max(0, srcTotal - srcInStock);

        sup.sourceTotalProducts = srcTotal;
        sup.sourceInStockProducts = srcInStock;
        sup.sourceOutOfStockProducts = srcOutOfStock;

        supplierStats[sup.id] = {
          name: sup.name,
          enabled: sup.enabled,
          status: sup.status,
          lastError: sup.lastError,
          sourceTotalProducts: srcTotal,
          sourceInStockProducts: srcInStock,
          sourceOutOfStockProducts: srcOutOfStock,
          matchedCount: 0,
          ambiguousCount: 0,
          variantsCount: 0,
          inStockColorsCount: 0,
        };
      })
    );

    // 2. Build Fast Lookup Indexes for each connected supplier
    const supplierIndexes: Record<string, SupplierCatalogIndex> = {};
    for (const sup of enabledSuppliers) {
      const items = supplierCatalogs[sup.id] || [];
      if (items.length === 0) continue;

      const index: SupplierCatalogIndex = {
        barcodeMap: new Map(),
        skuMap: new Map(),
        idMap: new Map(),
        brandModelMap: new Map(),
        items,
      };

      for (const item of items) {
        if (item.barcode) index.barcodeMap.set(String(item.barcode).trim(), item);
        if (item.gtin) index.barcodeMap.set(String(item.gtin).trim(), item);
        if (item.ean) index.barcodeMap.set(String(item.ean).trim(), item);
        if (item.sku) index.skuMap.set(String(item.sku).trim().toLowerCase(), item);
        if (item.model_code) index.skuMap.set(String(item.model_code).trim().toLowerCase(), item);
        if (item.id !== undefined) index.idMap.set(String(item.id).trim(), item);

        const b = normalizeText(item.brand || item.brand_name || '');
        const m = normalizeText(item.model || item.title || item.name || '');
        if (b && m) {
          const key = `${b}:::${m}`;
          if (!index.brandModelMap.has(key)) index.brandModelMap.set(key, []);
          index.brandModelMap.get(key)!.push(item);
        }
      }
      supplierIndexes[sup.id] = index;
    }

    // تأمین‌کننده‌هایی که در این دور خطا داده‌اند: برای کالاهای وابسته به آن‌ها نباید «ناموجود» اعلام شود
    const failedSupplierIds = new Set(enabledSuppliers.filter((s) => s.status !== 'connected').map((s) => s.id));

    // تأمین‌کننده‌های «منجمد»: خطادار یا غیرفعال — آخرین قیمت/موجودی اعمال‌شده از آن‌ها دست‌نخورده می‌ماند
    const frozenSupplierIds = new Set<string>([...failedSupplierIds, ...suppliers.filter((s) => !s.enabled).map((s) => s.id)]);

    // جزئیات تطبیق برای نمایش با کلیک روی باکس‌های آماری
    const details: Record<string, { matched: any[]; colors: any[]; ambiguous: any[] }> = {};
    for (const sup of enabledSuppliers) details[sup.id] = { matched: [], colors: [], ambiguous: [] };
    const pLabel = (p: any) => String(p.persianName || p.name || p.id);

    let updatedProductsCount = 0;

    // 3. Match Master Products & Apply Ultra-Precise Multi-Supplier Pricing
    for (let pIdx = 0; pIdx < masterProducts.length; pIdx++) {
      const product = masterProducts[pIdx];

      if (String(product.id).startsWith('prod-ks-')) {
        const numId = String(product.id).replace('prod-ks-', '');
        if (!product.supplierMatches) product.supplierMatches = {};
        product.supplierMatches.kasra = { supplierProductId: numId };
      } else if (String(product.id).startsWith('prod-ht-')) {
        const numId = String(product.id).replace('prod-ht-', '');
        if (!product.supplierMatches) product.supplierMatches = {};
        product.supplierMatches.hamrahtel = { supplierProductId: numId };
      } else if (String(product.id).startsWith('prod-eh-')) {
        const numId = String(product.id).replace('prod-eh-', '');
        if (!product.supplierMatches) product.supplierMatches = {};
        product.supplierMatches.ehadish = { supplierProductId: numId };
      } else if (String(product.id).startsWith('kasra-')) {
        const numId = String(product.id).replace(/\D+/g, '');
        product.id = `pk-${numId}`;
        if (!product.supplierMatches) product.supplierMatches = {};
        product.supplierMatches.kasra = { supplierProductId: numId };
      }
      product.source = 'puzzlekala';

      const productMatches: SupplierProductMatch[] = [];

      for (const sup of enabledSuppliers) {
        const items = supplierCatalogs[sup.id] || [];
        const index = supplierIndexes[sup.id];
        const adapter = ADAPTERS[sup.id] || { ...UniversalSupplierAdapter, id: sup.id, name: sup.name };
        if (!adapter || items.length === 0) continue;

        const match = adapter.matchProduct(product, items, index);
        if (match) {
          if (match.confidence === 'ambiguous') {
            const pColors = (() => {
              if (Array.isArray(product.variants)) {
                const colorVar = product.variants.find((v: any) => v.type === 'color' || v.name === 'رنگ' || v.title?.includes('رنگ'));
                if (colorVar && Array.isArray(colorVar.options) && colorVar.options.length > 0) {
                  return colorVar.options.map((o: any) => o.name || o.value || o.title).filter(Boolean).join('، ');
                }
              }
              if (Array.isArray(product.colors) && product.colors.length > 0) {
                return product.colors.map((c: any) => (typeof c === 'string' ? c : c.name || c.title)).filter(Boolean).join('، ');
              }
              return product.color ? String(product.color) : 'عمومی / تمام رنگ‌ها';
            })();
            details[sup.id].ambiguous.push({
              productId: product.id,
              productName: pLabel(product),
              productColor: pColors,
              productPrice: product.price ?? null,
              kind: 'product',
              reason: match.matchReason || 'تطبیق مبهم',
              candidates: match.candidates || [],
            });
            recordAuditLog(
              'sync_ambiguous_match',
              `تطبیق مبهم برای کالای ${pLabel(product)} در ${sup.name}: ${match.matchReason || ''}`,
              'multi-supplier-sync',
              { productId: product.id, supplierId: sup.id }
            );
          } else {
            productMatches.push(match);
          }
        }
      }

      if (productMatches.length === 0) continue;

      // هر Match قطعی/بالا در جزئیات تأمین‌کننده ثبت می‌شود؛ شمارنده‌ها باید با جزئیات واقعی یکی باشند.
      for (const m of productMatches) {
        const d = details[m.supplierId];
        if (d) d.matched.push({ productId: product.id, productName: pLabel(product), confidence: m.confidence, reason: m.matchReason || '', supplierProductId: m.supplierProductId ?? null });
      }

      // ----------------------------------------------------------------------
      // 4. Multi-Supplier Pricing Rule:
      // If a product or color is available across multiple suppliers:
      // selectedSourcePrice = MAX(valid source prices from in-stock suppliers)
      // finalPrice = selectedSourcePrice * (1 + markupRate) [Strict Single Markup]
      // ----------------------------------------------------------------------
      interface ColorPriceEntry {
        price: number;
        supplierId: string;
        supplierName: string;
        stock?: number;
      }

      const colorPriceMap = new Map<string, ColorPriceEntry[]>();
      const directItemPrices: ColorPriceEntry[] = [];

      for (const match of productMatches) {
        const supInfo = enabledSuppliers.find((s) => s.id === match.supplierId);
        const supName = supInfo ? supInfo.name : match.supplierId;

        for (const v of match.variants) {
          if (v.sourcePrice && Number(v.sourcePrice) > 0 && v.inStock) {
            const canonicalColor = v.normalizedColorName || normalizeColor(v.colorName);
            if (!colorPriceMap.has(canonicalColor)) {
              colorPriceMap.set(canonicalColor, []);
            }
            colorPriceMap.get(canonicalColor)!.push({
              price: Number(v.sourcePrice),
              supplierId: match.supplierId,
              supplierName: supName,
              stock: v.stock !== undefined ? Number(v.stock) : undefined,
            });
            directItemPrices.push({
              price: Number(v.sourcePrice),
              supplierId: match.supplierId,
              supplierName: supName,
            });
          }
        }
      }

      let productChanged = false;

      // CASE A: Product has Color Variants
      if (colorPriceMap.size > 0) {
        for (const match of productMatches) {
          supplierStats[match.supplierId].variantsCount += match.variants.length;
        }

        // فقط رنگ‌هایی قیمت‌گذاری می‌شوند که با رنگ‌های ثبت‌شده در پازل کالا تطبیق دارند؛ رنگ ناشناخته هرگز خودکار اضافه نمی‌شود.
        {
          const grp = Array.isArray(product.variants) ? product.variants.find((v: any) => v.type === 'color' || v.name === 'رنگ') || product.variants[0] : null;
          const masterOptions: any[] = grp && Array.isArray(grp.options) ? grp.options : [];
          if (masterOptions.length > 0) {
            for (const colName of [...colorPriceMap.keys()]) {
              const known = masterOptions.some((opt: any) => normalizeColor(opt.name) === colName || opt.name === colName);
              if (!known) {
                for (const ent of colorPriceMap.get(colName)!) {
                  details[ent.supplierId]?.ambiguous.push({ productId: product.id, productName: pLabel(product), kind: 'color', reason: `رنگ «${colName}» در پازل کالا تعریف نشده؛ قیمت اعمال نشد`, candidates: [] });
                }
                colorPriceMap.delete(colName);
              }
            }
            if (colorPriceMap.size === 0) continue; // هیچ رنگی تطبیق نخورد → تغییری اعمال نمی‌شود (موجودی/قیمت قبلی حفظ می‌شود)
          }
          const matchedHere = new Set<string>();
          for (const [colName, entries] of colorPriceMap.entries()) {
            const top = Math.max(...entries.map((e) => e.price));
            for (const ent of entries) {
              matchedHere.add(ent.supplierId);
              details[ent.supplierId]?.colors.push({ productId: product.id, productName: pLabel(product), color: colName, supplierPrice: ent.price, sitePrice: Math.round(top * (1 + markupRate)), usedForSitePrice: ent.price === top });
            }
          }
          for (const sid of matchedHere) {
            const m = productMatches.find((x) => x.supplierId === sid);
            details[sid]?.matched.push({ productId: product.id, productName: pLabel(product), confidence: m?.confidence, reason: m?.matchReason, supplierProductId: m?.supplierProductId ?? null });
          }
        }

        let highestOverallFinalPrice = 0;
        let selectedReferenceSupplierId = '';
        let selectedReferenceSupplierName = '';

        if (!Array.isArray(product.variants) || product.variants.length === 0) {
          product.variants = [
            {
              id: 'var-color',
              name: 'رنگ',
              type: 'color',
              options: [],
            },
          ];
        }

        const colorGroup =
          product.variants.find((v: any) => v.type === 'color' || v.name === 'رنگ') || product.variants[0];

        if (colorGroup && Array.isArray(colorGroup.options)) {
          const matchedOptionIds = new Set<string>();

          for (const [colName, entries] of colorPriceMap.entries()) {
            // Rule 1 & Rule 2:
            // If multiple suppliers have this color: pick entry with MAXIMUM (بیشترین) source price
            // If single supplier has this color: pick that supplier's source price
            let bestEntry = entries[0];
            for (const ent of entries) {
              if (ent.price > bestEntry.price) {
                bestEntry = ent;
              }
            }

            const maxSourcePrice = bestEntry.price;
            const finalVariantPrice = Math.round(maxSourcePrice * (1 + markupRate));
            details[bestEntry.supplierId]?.colors.push({ productId: product.id, productName: pLabel(product), color: colName, supplierPrice: maxSourcePrice, sitePrice: finalVariantPrice, usedForSitePrice: true });

            let existingOption = colorGroup.options.find(
              (opt: any) => normalizeColor(opt.name) === colName || opt.name === colName
            );

            // حفاظ جهش قیمت: قیمت/موجودی این رنگ تغییر نمی‌کند و در لیست «نیازمند بررسی» ثبت می‌شود
            if (existingOption && isSuspiciousJump(existingOption.price, finalVariantPrice, existingOption.approvedSourcePrice, maxSourcePrice)) {
              matchedOptionIds.add(existingOption.id);
              const pct = Math.round(jumpPercentOf(existingOption.price, finalVariantPrice));
              details[bestEntry.supplierId]?.ambiguous.push({
                productId: product.id,
                productName: pLabel(product),
                kind: 'price_jump',
                reason: `جهش قیمت مشکوک برای رنگ «${colName}»: قیمت فعلی سایت ${existingOption.price} ← قیمت جدید ${finalVariantPrice} (${pct}٪ تغییر؛ حد مجاز ${jumpGuardPercent}٪). اعمال نشد.`,
                candidates: [],
                currentPrice: existingOption.price,
                newPrice: finalVariantPrice,
                newSourcePrice: maxSourcePrice,
                color: colName,
                supplierId: bestEntry.supplierId,
              });
              if (existingOption.priceJumpHeldSource !== maxSourcePrice) {
                existingOption.priceJumpHeldSource = maxSourcePrice;
                productChanged = true;
                recordAuditLog(
                  'sync_price_jump_held',
                  `جهش قیمت مشکوک برای ${pLabel(product)} (${colName}): ${existingOption.price} ← ${finalVariantPrice} (${pct}٪). اعمال نشد.`,
                  'multi-supplier-sync',
                  { productId: product.id, supplierId: bestEntry.supplierId, color: colName }
                );
              }
              // قیمت فعلی این رنگ در محاسبهٔ قیمت پایهٔ محصول حفظ می‌شود
              if (existingOption.price > highestOverallFinalPrice) {
                highestOverallFinalPrice = existingOption.price;
                selectedReferenceSupplierId = existingOption.referenceSupplierId || bestEntry.supplierId;
                selectedReferenceSupplierName = existingOption.referenceSupplierName || bestEntry.supplierName;
              }
              continue;
            }

            if (finalVariantPrice > highestOverallFinalPrice) {
              highestOverallFinalPrice = finalVariantPrice;
              selectedReferenceSupplierId = bestEntry.supplierId;
              selectedReferenceSupplierName = bestEntry.supplierName;
            }

            if (existingOption) {
              matchedOptionIds.add(existingOption.id);
              if (
                existingOption.sourcePrice !== maxSourcePrice ||
                existingOption.price !== finalVariantPrice ||
                existingOption.referenceSupplierId !== bestEntry.supplierId ||
                existingOption.inStock !== true
              ) {
                existingOption.sourcePrice = maxSourcePrice;
                existingOption.markupRate = markupRate;
                delete existingOption.priceJumpHeldSource;
                delete existingOption.approvedSourcePrice;
                existingOption.price = finalVariantPrice;
                existingOption.referenceSupplierId = bestEntry.supplierId;
                existingOption.referenceSupplierName = bestEntry.supplierName;
                existingOption.inStock = true;
                existingOption.stock = bestEntry.stock !== undefined ? bestEntry.stock : 10;
                productChanged = true;
              }
            } else {
              const newOptId = `opt-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
              matchedOptionIds.add(newOptId);
              colorGroup.options.push({
                id: newOptId,
                name: colName,
                sourcePrice: maxSourcePrice,
                markupRate: markupRate,
                price: finalVariantPrice,
                referenceSupplierId: bestEntry.supplierId,
                referenceSupplierName: bestEntry.supplierName,
                inStock: true,
                stock: bestEntry.stock !== undefined ? bestEntry.stock : undefined,
              });
              productChanged = true;
            }
          }

          // Rule 3: Any color option that NONE of the suppliers have in stock MUST be marked as OUT OF STOCK (ناموجود)!
          for (const opt of colorGroup.options) {
            if (!matchedOptionIds.has(opt.id)) {
              // خطای موقت تأمین‌کننده مرجع نباید رنگ را ناموجود کند؛ آخرین وضعیت حفظ می‌شود
              if (opt.referenceSupplierId && frozenSupplierIds.has(opt.referenceSupplierId)) continue;
              if (opt.inStock !== false || opt.stock !== 0 || opt.priceDelta !== 0) {
                opt.inStock = false;
                opt.stock = 0;
                opt.priceDelta = 0;
                productChanged = true;
              }
            }
          }

          // Sort options so available (inStock: true) colors appear first, followed by out-of-stock colors
          colorGroup.options.sort((a: any, b: any) => {
            const aStock = a.inStock ? 1 : 0;
            const bStock = b.inStock ? 1 : 0;
            return bStock - aStock;
          });
        }

        if (highestOverallFinalPrice > 0 && product.price !== highestOverallFinalPrice) {
          product.price = highestOverallFinalPrice;
          product.sourcePrice = Math.round(highestOverallFinalPrice / (1 + markupRate));
          product.syncedPrice = highestOverallFinalPrice;
          product.inStock = true;
          productChanged = true;
        }

        // Synchronize priceDelta for all color options relative to base price
        if (colorGroup && Array.isArray(colorGroup.options)) {
          for (const opt of colorGroup.options) {
            if (opt.inStock && typeof opt.price === 'number' && highestOverallFinalPrice > 0) {
              const delta = opt.price - highestOverallFinalPrice;
              if (opt.priceDelta !== delta) {
                opt.priceDelta = delta;
                productChanged = true;
              }
            } else if (!opt.inStock) {
              if (opt.priceDelta !== 0) {
                opt.priceDelta = 0;
                productChanged = true;
              }
            }
          }
        }

        // Keep product.inStock strictly aligned with whether ANY color is in stock
        if (colorGroup && Array.isArray(colorGroup.options)) {
          const hasAnyStock = colorGroup.options.some((opt: any) => opt.inStock === true);
          if (product.inStock !== hasAnyStock) {
            product.inStock = hasAnyStock;
            productChanged = true;
          }
        }

        // Keep product.colors in sync with colorGroup.options
        if (colorGroup && Array.isArray(colorGroup.options)) {
          product.colors = colorGroup.options.map((opt: any) => ({
            id: opt.id,
            name: opt.name,
            colorCode: opt.colorCode || "#1e293b",
            price: opt.price || product.price,
            priceDelta: opt.priceDelta || 0,
            inStock: Boolean(opt.inStock),
            stock: opt.inStock ? (opt.stock ?? null) : 0,
          }));
        }
        if (selectedReferenceSupplierName && product.referenceSupplierName !== selectedReferenceSupplierName) {
          product.referenceSupplierId = selectedReferenceSupplierId;
          product.referenceSupplierName = selectedReferenceSupplierName;
          product.supplierName = selectedReferenceSupplierName;
          productChanged = true;
        }

        product.lastSyncedAt = nowIso;
        product.syncStatus = 'synced';

        if (productChanged) {
          updatedProductsCount++;
        }
      } else if (directItemPrices.length > 0) {
        // CASE B: Single-Price Product (no color variants)
        let bestEntry = directItemPrices[0];
        for (const ent of directItemPrices) {
          if (ent.price > bestEntry.price) {
            bestEntry = ent;
          }
        }

        const maxSourcePrice = bestEntry.price;
        const finalPrice = Math.round(maxSourcePrice * (1 + markupRate));
        {
          const seenSup = new Set<string>();
          for (const ent of directItemPrices) {
            details[ent.supplierId]?.colors.push({ productId: product.id, productName: pLabel(product), color: 'قیمت واحد (بدون رنگ)', supplierPrice: ent.price, sitePrice: finalPrice, usedForSitePrice: ent.price === maxSourcePrice });
            if (!seenSup.has(ent.supplierId)) {
              seenSup.add(ent.supplierId);
              const m = productMatches.find((x) => x.supplierId === ent.supplierId);
              details[ent.supplierId]?.matched.push({ productId: product.id, productName: pLabel(product), confidence: m?.confidence, reason: m?.matchReason, supplierProductId: m?.supplierProductId ?? null });
            }
          }
        }

        if (isSuspiciousJump(product.price, finalPrice, product.approvedSourcePrice, maxSourcePrice)) {
          const pct = Math.round(jumpPercentOf(product.price, finalPrice));
          details[bestEntry.supplierId]?.ambiguous.push({
            productId: product.id,
            productName: pLabel(product),
            kind: 'price_jump',
            reason: `جهش قیمت مشکوک: قیمت فعلی سایت ${product.price} ← قیمت جدید ${finalPrice} (${pct}٪ تغییر؛ حد مجاز ${jumpGuardPercent}٪). اعمال نشد.`,
            candidates: [],
            currentPrice: product.price,
            newPrice: finalPrice,
            newSourcePrice: maxSourcePrice,
            supplierId: bestEntry.supplierId,
          });
          if (product.priceJumpHeldSource !== maxSourcePrice) {
            product.priceJumpHeldSource = maxSourcePrice;
            productChanged = true;
            updatedProductsCount++;
            recordAuditLog(
              'sync_price_jump_held',
              `جهش قیمت مشکوک برای ${pLabel(product)}: ${product.price} ← ${finalPrice} (${pct}٪). اعمال نشد.`,
              'multi-supplier-sync',
              { productId: product.id, supplierId: bestEntry.supplierId }
            );
          }
        } else if (
          product.price !== finalPrice ||
          product.sourcePrice !== maxSourcePrice ||
          product.referenceSupplierId !== bestEntry.supplierId ||
          product.inStock !== true ||
          product.syncStatus !== 'synced'
        ) {
          delete product.priceJumpHeldSource;
          delete product.approvedSourcePrice;
          product.price = finalPrice;
          product.sourcePrice = maxSourcePrice;
          product.syncedPrice = finalPrice;
          product.referenceSupplierId = bestEntry.supplierId;
          product.referenceSupplierName = bestEntry.supplierName;
          product.supplierName = bestEntry.supplierName;
          product.inStock = true;
          product.lastSyncedAt = nowIso;
          product.syncStatus = 'synced';
          productChanged = true;
          updatedProductsCount++;
        }
      } else {
        // CASE C: تطبیق دقیق وجود دارد ولی هیچ تأمین‌کننده سالمی موجودی ندارد → کالا ناموجود می‌شود (قیمت قبلی حفظ می‌شود)
        const hasFailedEnabledSupplier = enabledSuppliers.some((s) => s.status !== 'connected');
        const dependsOnFailed =
          enabledSuppliers.length === 0 ||
          hasFailedEnabledSupplier ||
          Boolean(product.referenceSupplierId && frozenSupplierIds.has(product.referenceSupplierId));
        if (!dependsOnFailed) {
          let changedC = false;
          if (product.inStock !== false) { product.inStock = false; changedC = true; }
          const groups = Array.isArray(product.variants) ? product.variants : [];
          for (const g of groups) {
            if (g.type !== 'color' && g.name !== 'رنگ') continue;
            for (const opt of g.options || []) {
              if (opt.inStock !== false || opt.stock !== 0) { opt.inStock = false; opt.stock = 0; changedC = true; }
            }
          }
          if (Array.isArray(product.colors)) {
            for (const c of product.colors) {
              if (c.inStock !== false || c.stock !== 0) { c.inStock = false; c.stock = 0; changedC = true; }
            }
          }
          product.lastSyncedAt = nowIso;
          product.syncStatus = 'synced';
          if (changedC) { productChanged = true; updatedProductsCount++; }
        }
      }
    }

    // شمارنده‌های باکس‌ها دقیقاً از همان فهرست‌های جزئیات ساخته می‌شود (عدد باکس = تعداد ردیف‌های جزئیات)
    const detailsPath = path.join(DATA_DIR, 'supplier_match_details.json');
    const savedDetails = readJsonFile<Record<string, any>>(detailsPath, {});
    for (const sup of enabledSuppliers) {
      const d = details[sup.id];
      d.matched = Array.from(new Map(d.matched.map((m: any) => [`${m.productId}:${m.supplierProductId ?? ''}`, m])).values());
      d.colors = Array.from(new Map(d.colors.map((m: any) => [`${m.productId}:${m.color}:${m.supplierPrice}`, m])).values());
      // تعداد اقلام یکتای هماهنگ‌شده از این تأمین‌کننده در پازل کالا (حداکثر به اندازه کل کاتالوگ تأمین‌کننده)
      const uniqueSupplierMatchedIds = new Set(
        d.matched.map((m: any) => String(m.supplierProductId || m.productId)).filter(Boolean)
      ).size;
      sup.matchedCount = Math.min(sup.sourceTotalProducts || uniqueSupplierMatchedIds, uniqueSupplierMatchedIds);
      sup.inStockColorsCount = d.colors.length;
      sup.ambiguousCount = d.ambiguous.length;
      Object.assign(supplierStats[sup.id], { matchedCount: sup.matchedCount, inStockColorsCount: sup.inStockColorsCount, ambiguousCount: sup.ambiguousCount });
      savedDetails[sup.id] = { ...d, updatedAt: nowIso };
    }
    writeJsonFile(detailsPath, savedDetails);

    // Save updated Master Products and Supplier stats
    if (updatedProductsCount > 0) {
      writeJsonFile(productsPath, masterProducts);
    }
    saveSuppliersList(suppliers);

    // Notify listeners
    if (typeof onUpdateNotify === 'function' && updatedProductsCount > 0) {
      onUpdateNotify();
    }

    const connectedCount = enabledSuppliers.filter((s) => s.status === 'connected').length;
    const totalMatched = Object.values(supplierStats).reduce((a, s: any) => a + (s.matchedCount || 0), 0);

    const message =
      enabledSuppliers.length === 0
        ? 'هیچ تأمین‌کننده فعال و قابل دسترسی برای همگام‌سازی پیدا نشد.'
        : `همگام‌سازی هوشمند چندتأمین‌کننده انجام شد — ${enabledSuppliers.length} تأمین‌کننده بررسی شدند (${connectedCount} متصل)، ${totalMatched} کالا با بررسی دقیق مدل، رم، حافظه، پارت نامبر و کشور سازنده تطبیق داده شد، ${updatedProductsCount} کالا بر مبنای بیشترین قیمت تأمین‌کنندگان + نرخ مصوب (${approvedMarkupPercent}٪) به‌روزرسانی شد.`;

    recordAuditLog(
      'multi_supplier_sync',
      message,
      'admin',
      {
        enabledCount: enabledSuppliers.length,
        connectedCount,
        totalMatched,
        updatedProductsCount,
        markupPercent: approvedMarkupPercent,
      }
    );

    return {
      success: true,
      message,
      updatedMasterProducts: updatedProductsCount,
      supplierStats,
      timestamp: nowIso,
    };
  } finally {
    isSyncRunning = false;
  }
}

// ============================================================================
// 8. Background 30-Second Single-Loop Timer
// ============================================================================

let loopInterval: NodeJS.Timeout | null = null;

export function start30sMultiSupplierLoop(onUpdateNotify?: () => void) {
  // نام تابع برای سازگاری حفظ شده؛ فاصله زمانی با SYNC_INTERVAL_MINUTES (پیش‌فرض ۵ دقیقه) تنظیم می‌شود.
  if (loopInterval) {
    return;
  }
  const minutes = Math.max(1, Number(process.env.SYNC_INTERVAL_MINUTES) || 5);

  setTimeout(() => {
    executeMultiSupplierSync(onUpdateNotify).catch((err) => {
      console.error('[SupplierEngine] Error in initial sync:', err);
    });
  }, 3000);

  loopInterval = setInterval(() => {
    executeMultiSupplierSync(onUpdateNotify).catch((err) => {
      console.error('[SupplierEngine] Error in background sync:', err);
    });
  }, minutes * 60000);

  console.log(`[SupplierEngine] Multi-Supplier sync loop activated (every ${minutes} min).`);
}

export function stop30sMultiSupplierLoop() {
  if (loopInterval) {
    clearInterval(loopInterval);
    loopInterval = null;
    console.log('[SupplierEngine] Multi-Supplier 30-second sync loop stopped.');
  }
}
