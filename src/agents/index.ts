import { executeMultiSupplierSync } from '../supplierEngine.js';
import { runPriceMonitor } from './priceMonitor.js';
import { runMatchReviewer } from './matchReviewer.js';
import { runBestSupplier } from './bestSupplier.js';
import { runDailyReport } from './dailyReport.js';
import { readJson, loadCatalogs } from './common.js';
import type { AgentReport } from './common.js';

export { runPriceMonitor, runMatchReviewer, runBestSupplier, runDailyReport };

let timers: NodeJS.Timeout[] = [];
const safe = (name: string, fn: () => Promise<unknown>) => () => fn().catch((e) => console.error(`[agents:${name}]`, e?.message || e));

// یک چرخه کامل: همگام‌سازی تأمین‌کنندگان (اعمال قیمت/موجودی روی سایت) ← پایش و گزارش تغییرها
let cycleRunning = false;
export async function runCycle() {
  if (cycleRunning) return null;
  cycleRunning = true;
  try {
    const sync = await executeMultiSupplierSync();
    const rep = await runPriceMonitor();
    return { sync, rep };
  } finally { cycleRunning = false; }
}

export function startAgents(opts: { cycleMinutes?: number; dailyHour?: number } = {}) {
  stopAgents();
  const minutes = Math.max(1, opts.cycleMinutes ?? (Number(process.env.SYNC_INTERVAL_MINUTES) || 5));
  setTimeout(safe('cycle', runCycle), 3000);
  timers.push(setInterval(safe('cycle', runCycle), minutes * 60e3));
  let lastDaily = '';
  timers.push(setInterval(safe('daily', async () => {
    const d = new Date();
    if (d.getHours() === (opts.dailyHour ?? 9) && lastDaily !== d.toDateString()) {
      lastDaily = d.toDateString();
      const catalogs = await loadCatalogs(); // یک بار دریافت کاتالوگ برای هر دو ایجنت
      await runMatchReviewer({ catalogs }); await runBestSupplier({ catalogs }); await runDailyReport();
    }
  }), 60e3));
  console.log(`[PuzzleKala] Sync + agents cycle started (every ${minutes} min).`);
}
export function stopAgents() { timers.forEach(clearInterval); timers = []; }

// مسیرهای API: با AGENTS_API_KEY (هدر x-agents-key) محافظت می‌شوند؛ بدون کلید فقط از localhost.
export function registerAgentRoutes(app: any) {
  const guard = (req: any, res: any, next: any) => {
    const key = process.env.AGENTS_API_KEY;
    if (key ? req.headers['x-agents-key'] === key : ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)) return next();
    res.status(403).json({ error: 'forbidden' });
  };
  app.get('/api/agents/reports', guard, (req: any, res: any) => {
    const a = req.query.agent; const all = readJson<AgentReport[]>('agent_reports.json', []);
    res.json(all.filter((r) => !a || r.agent === a).slice(-50).reverse());
  });
  app.post('/api/agents/run/:name', guard, async (req: any, res: any) => {
    const runners: Record<string, () => Promise<AgentReport>> = { priceMonitor: runPriceMonitor, matchReviewer: runMatchReviewer, bestSupplier: runBestSupplier, dailyReport: runDailyReport, cycle: (async () => (await runCycle())?.rep) as any };
    const r = runners[req.params.name]; if (!r) return res.status(404).json({ error: 'unknown agent' });
    try { res.json(await r()); } catch (e: any) { res.status(500).json({ error: e?.message }); }
  });
}
