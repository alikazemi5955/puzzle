// ایجنت ۱: پایش قیمت و موجودی — با کوچکترین تغییر قیمت هشدار می‌دهد و تاریخچه قیمت ثبت می‌کند.
// (اعمال قیمت روی سایت توسط موتور همگام‌سازی انجام می‌شود؛ این ایجنت بعد از هر دور، نتیجه را راستی‌آزمایی و گزارش می‌کند.)
import { readJson, writeJson, saveReport, fmt, notify } from './common.js';
import type { AgentAlert } from './common.js';

interface ColorSnap { name: string; inStock: boolean; price: number }
interface ProdSnap { name: string; price: number; inStock: boolean; colors: Record<string, ColorSnap> }
interface Snap { products: Record<string, ProdSnap>; suppliers: Record<string, { inStock: number }>; alerted: Record<string, string> }
const SNAP = 'agent_snapshots.json', HISTORY = 'price_history.json';
const COOLDOWN_MS = 6 * 3600e3;

export async function runPriceMonitor(opts: { minChangePercent?: number; staleMinutes?: number; suspiciousPercent?: number; send?: boolean } = {}) {
  const minPct = opts.minChangePercent ?? 0;            // ۰ = هر تغییری (حتی ۱ تومان)
  const suspicious = opts.suspiciousPercent ?? 30;      // جهش مشکوک: فقط علامت‌گذاری می‌شود، مانع اعمال نمی‌شود
  const staleMs = (opts.staleMinutes ?? 15) * 60e3, now = Date.now(), nowIso = new Date().toISOString();
  const products = readJson<any[]>('products.json', []);
  const suppliers = readJson<any[]>('suppliers.json', []);
  const markup = Number(readJson<any>('settings.json', {}).supplierMarkupPercent ?? 5) / 100;
  const prev = readJson<Snap>(SNAP, { products: {}, suppliers: {}, alerted: {} });
  const next: Snap = { products: {}, suppliers: {}, alerted: { ...prev.alerted } };
  const alerts: AgentAlert[] = [], history: any[] = [];
  const first = Object.keys(prev.products).length === 0;
  const pctTxt = (pct: number) => (Math.abs(pct) < 0.01 ? '<0.01' : Math.abs(pct).toFixed(2));
  const sev = (pct: number) => (Math.abs(pct) >= suspicious ? 'critical' : 'warning') as 'critical' | 'warning';

  for (const p of products) {
    const name = p.persianName || p.name;
    const colors: Record<string, ColorSnap> = {};
    for (const c of p.colors || []) colors[c.id] = { name: c.name, inStock: !!c.inStock, price: Number(c.price) || 0 };
    const cur: ProdSnap = { name, price: Number(p.price) || 0, inStock: p.inStock !== false, colors };
    next.products[p.id] = cur;
    const old = prev.products[p.id];

    // راستی‌آزمایی: قیمت سایت باید برابر «قیمت تأمین‌کننده × (۱+حاشیه)» باشد
    if (p.sourcePrice > 0 && p.syncStatus === 'synced' && cur.price > 0) {
      const expected = Math.round(p.sourcePrice * (1 + markup));
      if (Math.abs(expected - cur.price) / expected > 0.01) alerts.push({ key: `incons:${p.id}:${cur.price}`, type: 'price_inconsistent', severity: 'warning',
        message: `قیمت «${name}» (${fmt(cur.price)}) با قیمت تأمین‌کننده + ${markup * 100}٪ (${fmt(expected)}) هم‌خوانی ندارد`, data: { productId: p.id } });
    }

    if (!old) { if (!first) alerts.push({ key: `new:${p.id}`, type: 'product_added', severity: 'info', message: `محصول جدید «${name}» اضافه شد`, data: { productId: p.id } }); continue; }

    if (old.price > 0 && cur.price > 0 && cur.price !== old.price) {
      const pct = ((cur.price - old.price) / old.price) * 100;
      if (Math.abs(pct) >= minPct) {
        alerts.push({ key: `price:${p.id}:${cur.price}`, type: 'price_change', severity: sev(pct),
          message: `قیمت «${name}» ${pct > 0 ? 'افزایش' : 'کاهش'} ${pctTxt(pct)}٪ (${fmt(old.price)} ← ${fmt(cur.price)} تومان، اختلاف ${fmt(cur.price - old.price)})` + (Math.abs(pct) >= suspicious ? ' ⚠️ جهش بزرگ؛ لطفاً بررسی کنید' : ''),
          data: { productId: p.id, from: old.price, to: cur.price } });
        history.push({ productId: p.id, name, at: nowIso, from: old.price, to: cur.price, supplier: p.referenceSupplierName || null, scope: 'product' });
      }
    }
    if (old.inStock !== cur.inStock) alerts.push({ key: `stock:${p.id}:${cur.inStock}`, type: cur.inStock ? 'product_back_in_stock' : 'product_out_of_stock', severity: cur.inStock ? 'info' : 'warning', message: `«${name}» ${cur.inStock ? 'دوباره موجود شد' : 'کاملاً ناموجود شد'}`, data: { productId: p.id } });

    for (const [cid, c] of Object.entries(colors)) {
      const oc = old.colors[cid]; if (!oc) continue;
      if (oc.inStock !== c.inStock) alerts.push({ key: `color:${p.id}:${cid}:${c.inStock}`, type: c.inStock ? 'color_back_in_stock' : 'color_out_of_stock', severity: c.inStock ? 'info' : 'warning', message: `رنگ «${c.name}» از «${name}» ${c.inStock ? 'دوباره موجود شد' : 'ناموجود شد'}`, data: { productId: p.id, colorId: cid } });
      else if (c.inStock && oc.price > 0 && c.price > 0 && c.price !== oc.price) {
        const pct = ((c.price - oc.price) / oc.price) * 100;
        if (Math.abs(pct) >= minPct) {
          alerts.push({ key: `cprice:${p.id}:${cid}:${c.price}`, type: 'color_price_change', severity: sev(pct), message: `قیمت رنگ «${c.name}» از «${name}»: ${fmt(oc.price)} ← ${fmt(c.price)} تومان (${pct > 0 ? '+' : '-'}${pctTxt(pct)}٪)`, data: { productId: p.id, colorId: cid } });
          history.push({ productId: p.id, name, at: nowIso, from: oc.price, to: c.price, supplier: null, scope: `color:${c.name}` });
        }
      }
    }
  }

  for (const id of Object.keys(prev.products)) if (!next.products[id] && !first) alerts.push({ key: `rm:${id}`, type: 'product_removed', severity: 'warning', message: `محصول «${prev.products[id].name}» از فروشگاه حذف شده است`, data: { productId: id } });

  for (const s of suppliers) {
    if (!s.enabled) continue;
    next.suppliers[s.id] = { inStock: Number(s.sourceInStockProducts) || 0 };
    if (s.status !== 'connected' || s.lastError) alerts.push({ key: `sup_err:${s.id}:${s.lastError || s.status}`, type: 'supplier_error', severity: 'critical', message: `تأمین‌کننده ${s.name} در وضعیت «${s.status}» است${s.lastError ? ': ' + s.lastError : ''}. قیمت‌های وابسته به آن موقتاً به‌روز نمی‌شوند و کالاها ناموجود نمی‌شوند.`, data: { supplierId: s.id } });
    const last = s.lastSuccessAt ? Date.parse(s.lastSuccessAt) : 0;
    if (last && now - last > staleMs) alerts.push({ key: `sup_stale:${s.id}`, type: 'supplier_stale', severity: 'warning', message: `آخرین همگام‌سازی موفق ${s.name} ${Math.round((now - last) / 60e3)} دقیقه پیش بوده`, data: { supplierId: s.id } });
    const o = prev.suppliers[s.id]?.inStock;
    if (o && o > 20 && next.suppliers[s.id].inStock < o * 0.7) alerts.push({ key: `sup_drop:${s.id}:${next.suppliers[s.id].inStock}`, type: 'supplier_stock_drop', severity: 'warning', message: `تعداد کالاهای موجود ${s.name} از ${o} به ${next.suppliers[s.id].inStock} رسید`, data: { supplierId: s.id } });
  }

  // جلوگیری از هشدار تکراری (کلید شامل قیمت جدید است، پس هر تغییر تازه هشدار می‌دهد)
  const fresh = alerts.filter((a) => { const t = prev.alerted[a.key]; return !t || now - Date.parse(t) > COOLDOWN_MS; });
  for (const a of fresh) next.alerted[a.key] = nowIso;
  for (const k of Object.keys(next.alerted)) if (now - Date.parse(next.alerted[k]) > 3 * 86400e3) delete next.alerted[k];
  writeJson(SNAP, next);
  if (history.length) writeJson(HISTORY, [...readJson<any[]>(HISTORY, []), ...history].slice(-5000));

  const summary = first ? 'اولین اجرا: وضعیت پایه ثبت شد.' : fresh.length ? `${fresh.length} هشدار جدید` : 'تغییری دیده نشد.';
  const report = saveReport({ agent: 'priceMonitor', summary, alerts: fresh });
  if (opts.send !== false && fresh.some((a) => a.severity !== 'info')) await notify('🔔 پازل کالا\n' + fresh.map((a) => '• ' + a.message).join('\n'));
  return report;
}
