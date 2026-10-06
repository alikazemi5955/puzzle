import fs from 'fs';
import path from 'path';
import { KasraAdapter, HamrahTelAdapter, getSuppliersList, writeJsonFile } from '../src/supplierEngine.ts';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');

function detectBrand(title: string): string {
  const t = (title || '').toLowerCase();
  if (t.includes('apple') || t.includes('iphone') || t.includes('اپل') || t.includes('آیفون')) return 'اپل (Apple)';
  if (t.includes('samsung') || t.includes('galaxy') || t.includes('سامسونگ')) return 'سامسونگ (Samsung)';
  if (t.includes('xiaomi') || t.includes('redmi') || t.includes('poco') || t.includes('شیائومی')) return 'شیائومی (Xiaomi)';
  if (t.includes('motorola') || t.includes('موتورولا')) return 'موتورولا (Motorola)';
  if (t.includes('honor') || t.includes('آنر')) return 'آنر (Honor)';
  if (t.includes('realme') || t.includes('ریلمی')) return 'ریلمی (Realme)';
  if (t.includes('nokia') || t.includes('نوکیا')) return 'نوکیا (Nokia)';
  if (t.includes('orod') || t.includes('ارود') || t.includes('اورود')) return 'ارود (Orod)';
  if (t.includes('blackview') || t.includes('بلک ویو')) return 'بلک ویو (Blackview)';
  if (t.includes('huawei') || t.includes('هواوی')) return 'هواوی (Huawei)';
  if (t.includes('anker') || t.includes('soundcore') || t.includes('انکر')) return 'انکر (Anker)';
  if (t.includes('baseus') || t.includes('بیسوس')) return 'بیسوس (Baseus)';
  if (t.includes('proone') || t.includes('پرووان')) return 'پرووان (ProOne)';
  if (t.includes('sony') || t.includes('playstation') || t.includes('سونی')) return 'سونی (Sony)';
  return 'سایر برندها';
}

function detectCategory(title: string): string {
  const t = (title || '').toLowerCase();
  if (t.includes('کنسول') || t.includes('playstation') || t.includes('ps5') || t.includes('xbox')) return 'کنسول و بازی';
  if (t.includes('هدفون') || t.includes('هندزفری') || t.includes('ایرباد') || t.includes('earbuds') || t.includes('buds')) return 'هدفون و هندزفری';
  if (t.includes('ساعت') || t.includes('watch')) return 'ساعت هوشمند';
  if (t.includes('تبلت') || t.includes('tablet') || t.includes('pad')) return 'تبلت';
  if (t.includes('اسپیکر') || t.includes('speaker')) return 'اسپیکر';
  if (t.includes('پاوربانک') || t.includes('powerbank')) return 'پاوربانک';
  if (t.includes('کابل') || t.includes('شارژر') || t.includes('cable') || t.includes('charger')) return 'کابل و شارژر';
  return 'گوشی موبایل';
}

function getColorHex(name: string): string {
  const n = (name || '').toLowerCase();
  if (n.includes('مشکی') || n.includes('black')) return '#1e293b';
  if (n.includes('سفید') || n.includes('white')) return '#f8fafc';
  if (n.includes('آبی') || n.includes('blue')) return '#3b82f6';
  if (n.includes('سبز') || n.includes('green')) return '#10b981';
  if (n.includes('طلایی') || n.includes('gold')) return '#eab308';
  if (n.includes('نقره') || n.includes('silver')) return '#cbd5e1';
  if (n.includes('خاکستری') || n.includes('طوسی') || n.includes('gray')) return '#64748b';
  if (n.includes('بنفش') || n.includes('purple')) return '#a855f7';
  if (n.includes('صورتی') || n.includes('pink') || n.includes('رز')) return '#ec4899';
  if (n.includes('نارنجی') || n.includes('orange')) return '#f97316';
  return '#475569';
}

async function runImport() {
  console.log('--- Starting One-Time Full Products Import for Puzzle Kala ---');

  const sups = getSuppliersList();
  const kasraSup = sups.find((s) => s.id === 'kasra');
  const hamrahSup = sups.find((s) => s.id === 'hamrahtel');

  if (!kasraSup || !hamrahSup) {
    throw new Error('Suppliers not found in settings');
  }

  // Fetch Kasra brands & categories metadata
  const metaRes = await fetch('https://api.kasrapars.ir/api/web/v10/product/index?per-page=1');
  const metaJson = (await metaRes.json()) as any;
  const brandsMap = new Map<number, string>();
  for (const b of metaJson.filters?.brands || []) {
    brandsMap.set(b.id, b.brand_name || b.brand_name_en);
  }
  const catsMap = new Map<number, string>();
  for (const c of metaJson.filters?.leafCategories || []) {
    catsMap.set(c.id, c.name);
  }

  console.log('1. Fetching Kasra Plus catalog...');
  const kasraRes = await KasraAdapter.fetchCatalog(kasraSup);
  console.log(`Kasra Plus: ${kasraRes.items.length} items`);

  console.log('2. Fetching HamrahTel catalog...');
  const hamrahRes = await HamrahTelAdapter.fetchCatalog(hamrahSup);
  console.log(`HamrahTel: ${hamrahRes.items.length} items`);

  const allProducts: any[] = [];
  const seenIds = new Set<string>();

  // 1. Process all HamrahTel products
  for (const h of hamrahRes.items) {
    const rawId = String(h.slug || h.id).replace(/[^a-zA-Z0-9_-]/g, '-');
    const id = `prod-ht-${rawId}`;
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    const brand = detectBrand(h.name);
    const category = detectCategory(h.name);
    const price = Number(h.price || 0) > 0 ? Number(h.price) : 3850000;
    const stock = Number(h.stock || 0) > 0 ? Number(h.stock) : 25;
    const img = h.image && h.image.startsWith('http') ? h.image : '/logo.png';

    const variants = (h.variants || []).map((v: any) => {
      const vPrice = Number(v.price || 0) > 0 ? Number(v.price) : price;
      const vStock = Number(v.stock || 0);
      return {
        id: `var-${Math.random().toString(36).slice(2, 8)}`,
        name: v.name || v.color || 'پیش‌فرض',
        color: v.color || v.name || 'پیش‌فرض',
        colorCode: getColorHex(v.color || v.name),
        price: vPrice,
        priceDelta: vPrice - price,
        stock: vStock > 0 ? vStock : 10,
        inStock: v.inStock !== false && vStock > 0,
      };
    });

    const colors = variants.map((v: any) => ({
      id: v.id,
      name: v.color,
      colorCode: v.colorCode,
      price: v.price,
      priceDelta: v.priceDelta,
      inStock: v.inStock,
      stock: v.stock,
    }));

    allProducts.push({
      id,
      name: h.name,
      persianName: h.persianName || h.name,
      title: h.name,
      brand,
      category,
      price,
      stock,
      inStock: true,
      active: true,
      images: [img],
      image: img,
      slug: (h.slug || h.name).toLowerCase().replace(/[^a-z0-9\u0600-\u06FF]+/g, '-'),
      source: 'puzzlekala',
      sourceSupplier: 'hamrahtel',
      independent: true,
      noSupplierRules: true,
      variants: variants.length > 0 ? [{ id: 'grp-colors', type: 'color', name: 'رنگ', options: variants }] : [],
      colors: colors.length > 0 ? colors : undefined,
      createdAt: new Date().toISOString(),
    });
  }

  // 2. Process all Kasra Plus products
  for (const k of kasraRes.items) {
    const id = `prod-ks-${k.id}`;
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    const brand = brandsMap.get(k.brand_id) || detectBrand(k.product_name || k.name);
    const category = catsMap.get(k.category_id) || detectCategory(k.product_name || k.name);
    const img = k.src || k.image || '/logo.png';

    // Match with HamrahTel product for price if available
    const kNorm = (k.product_name_en || k.product_name || '').toLowerCase();
    const matchedHamrah = allProducts.find((p) => {
      if (p.sourceSupplier !== 'hamrahtel') return false;
      const pNorm = (p.name || '').toLowerCase();
      return pNorm.includes(kNorm) || (kNorm.length > 8 && pNorm.includes(kNorm.slice(0, 10)));
    });

    let price = matchedHamrah ? matchedHamrah.price : 0;
    if (price === 0) {
      if (kNorm.includes('ps5') || kNorm.includes('playstation')) price = 54500000;
      else if (kNorm.includes('iphone 13')) price = 42500000;
      else if (kNorm.includes('iphone 16')) price = 79000000;
      else if (kNorm.includes('buds') || kNorm.includes('airpods') || kNorm.includes('liberty')) price = 2850000;
      else if (kNorm.includes('power') || kNorm.includes('پاوربانک')) price = 1450000;
      else if (kNorm.includes('cable') || kNorm.includes('کابل')) price = 350000;
      else if (category === 'گوشی موبایل') price = 9500000;
      else price = 1200000;
    }

    allProducts.push({
      id,
      name: k.product_name_en || k.product_name || k.name,
      persianName: k.product_name || k.short_name || k.name,
      title: k.product_name || k.name,
      brand,
      category,
      price,
      stock: 15,
      inStock: true,
      active: true,
      images: [img],
      image: img,
      slug: (k.slug || k.product_name_en || `product-${k.id}`).toLowerCase().replace(/[^a-z0-9\u0600-\u06FF]+/g, '-'),
      source: 'puzzlekala',
      sourceSupplier: 'kasra',
      independent: true,
      noSupplierRules: true,
      createdAt: new Date().toISOString(),
    });
  }

  // Cross-pollinate images from Kasra to HamrahTel where exact phone models match
  let sharedImages = 0;
  for (const p of allProducts) {
    if (p.sourceSupplier === 'hamrahtel' && (!p.image || p.image === '/logo.png')) {
      const pNorm = (p.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const match = allProducts.find((k) => {
        if (k.sourceSupplier !== 'kasra' || !k.image || k.image === '/logo.png') return false;
        const kNorm = (k.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        return kNorm.includes(pNorm) || pNorm.includes(kNorm);
      });
      if (match) {
        p.image = match.image;
        p.images = [match.image];
        sharedImages++;
      }
    }
  }

  console.log(`Writing ${allProducts.length} products to ${PRODUCTS_FILE}...`);
  writeJsonFile(PRODUCTS_FILE, allProducts);

  console.log(`✅ Successfully imported ${allProducts.length} total products into Puzzle Kala!`);
  console.log(`- Kasra Plus products: ${allProducts.filter((p) => p.sourceSupplier === 'kasra').length}`);
  console.log(`- HamrahTel products: ${allProducts.filter((p) => p.sourceSupplier === 'hamrahtel').length}`);
  console.log(`- Products with high-res photos: ${allProducts.filter((p) => p.image && p.image !== '/logo.png').length}`);
  console.log(`- Shared high-res photos: ${sharedImages}`);
}

runImport().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
