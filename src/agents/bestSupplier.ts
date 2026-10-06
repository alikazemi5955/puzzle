// ایجنت ۳: مقایسه تأمین‌کننده‌ها. مشاوره‌ای است و قیمت‌ها را تغییر نمی‌دهد.
// توجه: قانون فعلی همگام‌سازی «بیشترین قیمت تأمین‌کننده + حاشیه» است؛ این ایجنت اثر قانون «ارزان‌ترین» را فقط نشان می‌دهد.
import { readJson, loadCatalogs, saveReport, fmt } from './common.js';
import type { AgentAlert } from './common.js';

export async function runBestSupplier(opts: { catalogs?: Awaited<ReturnType<typeof loadCatalogs>> } = {}) {
  const products = readJson<any[]>('products.json', []).filter((p) => p.active !== false);
  const markup = Number(readJson<any>('settings.json', {}).supplierMarkupPercent ?? 5) / 100;
  const catalogs = opts.catalogs ?? (await loadCatalogs());
  const rows: any[] = [], alerts: AgentAlert[] = [];

  for (const p of products) {
    const per: { supplierId: string; supplierName: string; minPrice: number; colors: number }[] = [];
    for (const { supplier, adapter, items, error } of catalogs) {
      if (error || !items.length) continue;
      const m = adapter.matchProduct(p, items);
      if (!m || (m.confidence !== 'exact' && m.confidence !== 'high')) continue;
      const live = (m.variants || []).filter((v) => v.inStock && Number(v.sourcePrice) > 0);
      if (live.length) per.push({ supplierId: supplier.id, supplierName: supplier.name, minPrice: Math.min(...live.map((v) => v.sourcePrice)), colors: live.length });
    }
    if (!per.length) { rows.push({ productId: p.id, name: p.name, suppliers: [], note: 'هیچ تأمین‌کننده‌ای موجود نیست' }); continue; }
    const cheapest = per.reduce((a, b) => (b.minPrice < a.minPrice ? b : a)), priciest = per.reduce((a, b) => (b.minPrice > a.minPrice ? b : a));
    const row = { productId: p.id, name: p.name, suppliers: per, cheapest: cheapest.supplierId, currentPolicyPrice: Math.round(priciest.minPrice * (1 + markup)),
      cheapestPolicyPrice: Math.round(cheapest.minPrice * (1 + markup)), diff: Math.round((priciest.minPrice - cheapest.minPrice) * (1 + markup)) };
    rows.push(row);
    if (per.length > 1 && row.diff > 0) alerts.push({ key: `best:${p.id}:${row.diff}`, type: 'cheaper_supplier', severity: 'info',
      message: `«${p.name}»: ارزان‌ترین ${cheapest.supplierName}؛ با قانون فعلی (بیشترین قیمت) ${fmt(row.diff)} تومان گران‌تر از حالت «ارزان‌ترین» فروخته می‌شود`, data: row });
  }
  return saveReport({ agent: 'bestSupplier', summary: `${rows.length} محصول مقایسه شد، ${alerts.length} مورد با اختلاف قیمت`, alerts, data: { rows, markupPercent: markup * 100 } });
}
