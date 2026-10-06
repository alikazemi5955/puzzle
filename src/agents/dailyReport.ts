// ایجنت ۴: گزارش روزانه (ذخیره در فایل + ارسال به تلگرام در صورت تنظیم)
import { readJson, saveReport, notify } from './common.js';
import type { AgentReport } from './common.js';

export function buildDailyText(): string {
  const since = Date.now() - 86400e3;
  const reps = readJson<AgentReport[]>('agent_reports.json', []).filter((r) => Date.parse(r.at) >= since && r.agent !== 'dailyReport');
  const sups = readJson<any[]>('suppliers.json', []), prods = readJson<any[]>('products.json', []);
  const alerts = reps.flatMap((r) => r.alerts), by = (t: string) => alerts.filter((a) => a.type === t);
  const uniq = (xs: string[]) => [...new Set(xs)];
  const L: string[] = ['📊 گزارش روزانه پازل کالا', ''];
  L.push('تأمین‌کنندگان:');
  for (const s of sups) L.push(`• ${s.name}: ${s.status}${s.lastError ? ' (خطا: ' + s.lastError + ')' : ''} — موجود ${s.sourceInStockProducts ?? '?'} از ${s.sourceTotalProducts ?? '?'} | هماهنگ: ${s.matchedCount ?? 0} کالا، ${s.inStockColorsCount ?? 0} رنگ | مبهم: ${s.ambiguousCount ?? 0}${s.enabled ? '' : ' | غیرفعال'}`);
  L.push('', `محصولات فعال: ${prods.filter((p) => p.active !== false).length} | ناموجود: ${prods.filter((p) => p.active !== false && p.inStock === false).length}`);
  const sec = (title: string, xs: string[]) => { if (xs.length) L.push('', title, ...uniq(xs).slice(0, 10).map((m) => '• ' + m)); };
  sec('تغییر قیمت‌ها:', by('price_change').map((a) => a.message));
  sec('رنگ‌های ناموجود شده:', by('color_out_of_stock').map((a) => a.message));
  sec('مشکل تأمین‌کننده:', [...by('supplier_error'), ...by('supplier_stale'), ...by('supplier_stock_drop')].map((a) => a.message));
  sec('پیشنهاد تطبیق برای بازبینی:', by('match_suggestion').map((a) => a.message));
  sec('اختلاف قیمت تأمین‌کننده‌ها:', by('cheaper_supplier').map((a) => a.message));
  if (alerts.length === 0) L.push('', 'در ۲۴ ساعت گذشته مورد خاصی ثبت نشد ✅');
  return L.join('\n');
}

export async function runDailyReport(opts: { send?: boolean } = {}) {
  const text = buildDailyText();
  const sent = opts.send === false ? { sent: false, reason: 'ارسال غیرفعال' } : await notify(text);
  return saveReport({ agent: 'dailyReport', summary: sent.sent ? 'گزارش ارسال شد' : `گزارش ساخته شد (ارسال نشد: ${sent.reason})`, alerts: [], data: { text, sent } });
}
