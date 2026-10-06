import path from 'path';
import { readJsonFile, writeJsonFile, getSuppliersList, KasraAdapter, HamrahTelAdapter, UniversalSupplierAdapter } from '../supplierEngine.js';
import type { Supplier, SupplierAdapter } from '../supplierEngine.js';

export const DATA_DIR = path.resolve(process.cwd(), 'data');
export const REPORTS_FILE = path.join(DATA_DIR, 'agent_reports.json');

export type Severity = 'info' | 'warning' | 'critical';
export interface AgentAlert { key: string; type: string; severity: Severity; message: string; data?: any }
export interface AgentReport { id: string; agent: string; at: string; summary: string; alerts: AgentAlert[]; data?: any }

export const readJson = <T,>(file: string, fb: T): T => readJsonFile<T>(path.join(DATA_DIR, file), fb);
export const writeJson = <T,>(file: string, d: T) => writeJsonFile(path.join(DATA_DIR, file), d);

export function saveReport(r: Omit<AgentReport, 'id' | 'at'>): AgentReport {
  const full: AgentReport = { id: `rep-${Date.now().toString(36)}`, at: new Date().toISOString(), ...r };
  const all = readJsonFile<AgentReport[]>(REPORTS_FILE, []);
  all.push(full);
  writeJsonFile(REPORTS_FILE, all.slice(-300));
  return full;
}

const ADAPTERS: Record<string, SupplierAdapter> = { kasra: KasraAdapter, hamrahtel: HamrahTelAdapter };
export const getAdapter = (s: Supplier): SupplierAdapter => ADAPTERS[s.id] || { ...UniversalSupplierAdapter, id: s.id, name: s.name };

export async function loadCatalogs(suppliers = getSuppliersList().filter((s) => s.enabled)) {
  const out: { supplier: Supplier; adapter: SupplierAdapter; items: any[]; error?: string }[] = [];
  await Promise.all(suppliers.map(async (supplier) => {
    const adapter = getAdapter(supplier);
    try { const r = await adapter.fetchCatalog(supplier); out.push({ supplier, adapter, items: r.items || [], error: r.success ? undefined : r.error }); }
    catch (e: any) { out.push({ supplier, adapter, items: [], error: e?.message || 'fetch failed' }); }
  }));
  return out;
}

export const fmt = (n: number) => Math.round(n).toLocaleString('fa-IR');

export async function notify(text: string): Promise<{ sent: boolean; reason?: string }> {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return { sent: false, reason: 'TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID تنظیم نشده' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: text.slice(0, 4000) }),
    });
    return res.ok ? { sent: true } : { sent: false, reason: `HTTP ${res.status}` };
  } catch (e: any) { return { sent: false, reason: e?.message }; }
}
