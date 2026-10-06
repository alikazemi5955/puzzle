import dotenv from 'dotenv';
dotenv.config();
import express, { Request, Response, NextFunction } from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
  executeMultiSupplierSync,
  getSuppliersList,
  saveSuppliersList,
  start30sMultiSupplierLoop,
  readJsonFile,
  writeJsonFile,
  recordAuditLog,
  normalizeColor,
  extractColorFromTitle,
  clearHamrahTelTokenCache,
} from './src/supplierEngine.js';
import { startAgents, registerAgentRoutes } from './src/agents/index.js';
import { smartRegister } from './src/smart/index.js';
import { runShoppingAssistant, assistantRateLimited } from './src/assistant.js';
import { hashPassword, isHashed, verifyPassword, createSession, getSession, getToken, requireRole, publicUser, digits, revokeUserSessions } from './src/auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;
const DATA_DIR = path.join(__dirname, 'data');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads'), { maxAge: '7d' }));

// Rate limiting سبک برای endpointهای احراز هویت؛ هدف جلوگیری از brute-force ساده است.
const authHits = new Map<string, { count: number; resetAt: number }>();
const authRateLimit = (max = 8, windowMs = 60_000) => (req: Request, res: Response, next: NextFunction) => {
  const key = String(req.ip || req.socket.remoteAddress || 'unknown');
  const now = Date.now();
  const cur = authHits.get(key);
  if (!cur || cur.resetAt <= now) { authHits.set(key, { count: 1, resetAt: now + windowMs }); return next(); }
  cur.count += 1;
  if (cur.count > max) return res.status(429).json({ success: false, message: 'تعداد تلاش‌ها زیاد است؛ لطفاً کمی بعد دوباره تلاش کنید.' });
  next();
};
registerAgentRoutes(app);

// Helper to get file path in data/
function getFilePath(filename: string): string {
  return path.join(DATA_DIR, filename);
}

// --------------------------------------------------------------------------
// API Routes
// --------------------------------------------------------------------------

// 1. Health
app.get('/api/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', time: new Date().toISOString(), port: PORT });
});

// Helper to sanitize product object
function sanitizeProduct(p: any): any {
  if (!p || typeof p !== 'object') return null;
  // If wrapped in nested products array, ignore
  if (Array.isArray(p.products)) return null;
  const name = String(p.name || p.persianName || p.title || 'کالای پازل کالا').trim();
  const persianName = String(p.persianName || name).trim();
  const brand = String(p.brand || '').trim();
  const category = String(p.category || '').trim();
  const id = String(p.id || `prod-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const baseSlug = (p.slug && typeof p.slug === 'string' && p.slug.trim())
    ? p.slug.trim()
    : (name || id || 'product').toLowerCase().replace(/[^a-z0-9\u0600-\u06FF]+/g, '-').replace(/^-+|-+$/g, '');

  const priceNum = Number(p.price !== undefined && p.price !== null && p.price !== '' ? p.price : 0);
  const stockNum = Number(p.stock !== undefined && p.stock !== null && p.stock !== '' ? p.stock : (p.inStock !== false ? 10 : 0));
  const inStockBool = p.inStock !== undefined ? Boolean(p.inStock) : (stockNum > 0);
  const activeBool = p.active !== undefined ? Boolean(p.active) : true;

  // پازل‌کالا تنوع RAM/حافظه را به‌عنوان Variant نگه نمی‌دارد؛ این دو فقط
  // در نام کالا و مشخصات فنی ثبت می‌شوند. تنوع مجاز فعلی: رنگ و گارانتی.
  const cleanVariants = Array.isArray(p.variants)
    ? p.variants.filter((v: any) => v && v.type !== 'storage' && v.type !== 'ram')
    : p.variants;

  return {
    ...p,
    id,
    name,
    persianName,
    brand,
    category,
    price: priceNum,
    stock: stockNum,
    inStock: inStockBool,
    active: activeBool,
    slug: baseSlug || id,
    source: p.source || (String(id).startsWith('prod-') ? 'puzzlekala' : undefined),
    ...(Array.isArray(p.variants) ? { variants: cleanVariants } : {}),
  };
}

function isUserRegisteredProduct(p: any): boolean {
  if (!p) return false;
  const idStr = String(p.id || '');
  // Supplier products have prefixes like pk- or kasra-
  // User created products have prefix prod- or source === 'puzzlekala'
  return idStr.startsWith('prod-') || p.source === 'puzzlekala';
}

function validateUserProduct(p: any): string | null {
  if (!p || typeof p !== 'object') return 'اطلاعات کالا نامعتبر است.';
  if (!String(p.name || '').trim()) return 'نام انگلیسی/مدل کالا الزامی است.';
  if (!String(p.persianName || '').trim()) return 'نام فارسی کالا الزامی است.';
  const price = Number(p.price);
  if (!Number.isFinite(price) || price < 0) return 'قیمت فروش کالا معتبر نیست (عدد مثبت یا ۰).';
  const stock = Number(p.stock);
  if (!Number.isFinite(stock) || stock < 0) return 'موجودی کالا معتبر نیست.';
  if (!Array.isArray(p.images) || p.images.filter((x: any) => String(x || '').trim()).length === 0) {
    p.images = ['/logo.png'];
  }
  return null;
}

// 2. Products
app.get('/api/products', (req: Request, res: Response) => {
  try {
    const rawProducts = readJsonFile<any[]>(getFilePath('products.json'), []);
    const sanitized = rawProducts
      .map(sanitizeProduct)
      .filter(Boolean)
      .filter(isUserRegisteredProduct);
    res.json(sanitized);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to read products', message: err?.message });
  }
});

const requireAdminOrBridge = (req: Request, res: Response, next: NextFunction) => {
  if (req.headers['x-sync-client'] === 'puzzle-bridge') return next();
  const s = getSession(req);
  if (s?.role === 'admin') return next();
  const t = getToken(req);
  if (t) {
    const sessionsList = readJsonFile<any[]>(path.resolve(process.cwd(), 'data', 'sessions.json'), []);
    if (sessionsList.some((sess) => sess.token === t && sess.role === 'admin' && sess.exp > Date.now())) {
      return next();
    }
  }
  return requireRole('admin')(req, res, next);
};

app.post('/api/products', requireAdminOrBridge, (req: Request, res: Response) => {
  try {
    let products = readJsonFile<any[]>(getFilePath('products.json'), [])
      .map(sanitizeProduct)
      .filter(Boolean)
      .filter(isUserRegisteredProduct);

    // If client sends bulk array of products:
    if (Array.isArray(req.body)) {
      const sanitizedList = req.body
        .map(sanitizeProduct)
        .filter(Boolean)
        .filter(isUserRegisteredProduct);
      const mergedMap = new Map<string, any>();
      for (const p of products) mergedMap.set(p.id, p);
      for (const p of sanitizedList) mergedMap.set(p.id, p);
      const finalList = Array.from(mergedMap.values());
      writeJsonFile(getFilePath('products.json'), finalList);
      return res.json({ success: true, count: finalList.length });
    }

    // If client sends { products: [...] }
    if (req.body && Array.isArray(req.body.products)) {
      const sanitizedList = req.body.products
        .map(sanitizeProduct)
        .filter(Boolean)
        .filter(isUserRegisteredProduct);
      const mergedMap = new Map<string, any>();
      for (const p of products) mergedMap.set(p.id, p);
      for (const p of sanitizedList) mergedMap.set(p.id, p);
      const finalList = Array.from(mergedMap.values());
      writeJsonFile(getFilePath('products.json'), finalList);
      return res.json({ success: true, count: finalList.length });
    }

    const newProduct = sanitizeProduct({ ...(req.body || {}), source: 'puzzlekala' });
    if (!newProduct) {
      return res.status(400).json({ success: false, error: 'Invalid product data' });
    }
    const validationError = validateUserProduct(newProduct);
    if (validationError) {
      return res.status(422).json({ success: false, error: validationError, message: validationError });
    }
    // محصولات ثبت‌شده از پنل باید با شناسه داخلی فروشگاه ذخیره شوند؛ شناسه خارجی تأمین‌کننده را نمی‌پذیریم.
    if (!isUserRegisteredProduct(newProduct)) {
      newProduct.id = `prod-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      newProduct.source = 'puzzlekala';
    }
    const existingIndex = products.findIndex((p) => p.id === newProduct.id);
    if (existingIndex >= 0) {
      products[existingIndex] = { ...products[existingIndex], ...newProduct };
    } else {
      products.push(newProduct);
    }
    writeJsonFile(getFilePath('products.json'), products);
    res.json({ success: true, product: newProduct });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to save product', message: err?.message });
  }
});

app.put('/api/products/:id', requireAdminOrBridge, (req: Request, res: Response) => {
  try {
    let products = readJsonFile<any[]>(getFilePath('products.json'), []).map(sanitizeProduct).filter(Boolean);
    const { id } = req.params;
    const index = products.findIndex((p) => p.id === id);
    if (index === -1) {
      return res.status(404).json({ error: 'Product not found' });
    }
    const updated = sanitizeProduct({ ...products[index], ...req.body, id, source: 'puzzlekala' });
    const validationError = validateUserProduct(updated);
    if (validationError) return res.status(422).json({ success: false, error: validationError, message: validationError });
    products[index] = updated;
    writeJsonFile(getFilePath('products.json'), products);
    res.json({ success: true, product: updated });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update product', message: err?.message });
  }
});

app.delete('/api/products/:id', requireAdminOrBridge, (req: Request, res: Response) => {
  try {
    let products = readJsonFile<any[]>(getFilePath('products.json'), []);
    const { id } = req.params;
    products = products.filter((p) => p.id !== id);
    writeJsonFile(getFilePath('products.json'), products);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to delete product', message: err?.message });
  }
});

// 3. Suppliers & Sync
app.get('/api/suppliers', (req: Request, res: Response) => {
  try {
    const suppliers = getSuppliersList();
    res.json({ success: true, suppliers, total: suppliers.length });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to get suppliers', message: err?.message, suppliers: [] });
  }
});

app.post('/api/suppliers/:id/toggle', (req: Request, res: Response) => {
  try {
    const suppliers = getSuppliersList();
    const { id } = req.params;
    const idx = suppliers.findIndex((s) => s.id === id);
    if (idx === -1) {
      return res.status(404).json({ success: false, error: 'Supplier not found' });
    }
    suppliers[idx].enabled = !suppliers[idx].enabled;
    // Enabling a supplier does not prove connectivity. Mark it as unavailable/pending
    // until an actual sync succeeds; never display a false "connected" state.
    suppliers[idx].status = suppliers[idx].enabled ? 'unavailable' : 'disconnected';
    if (suppliers[idx].enabled) {
      suppliers[idx].lastError = 'فعال شد؛ اتصال در اولین همگام‌سازی بررسی می‌شود.';
    } else {
      suppliers[idx].lastError = null;
    }
    saveSuppliersList(suppliers);
    res.json({ success: true, supplier: suppliers[idx], suppliers });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Failed to toggle supplier', message: err?.message });
  }
});

app.delete('/api/suppliers/:id', requireRole('admin'), (req: Request, res: Response) => {
  try {
    let suppliers = getSuppliersList();
    const { id } = req.params;
    suppliers = suppliers.filter((s) => s.id !== id);
    saveSuppliersList(suppliers);
    res.json({ success: true, message: 'Supplier deleted', suppliers });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Failed to delete supplier', message: err?.message });
  }
});

app.post('/api/suppliers', requireRole('admin'), (req: Request, res: Response) => {
  try {
    const suppliers = getSuppliersList();
    const newSup = req.body;
    if (!newSup.id) {
      newSup.id = `sup-${Date.now()}`;
    }
    const idx = suppliers.findIndex((s) => s.id === newSup.id);
    if (idx >= 0) {
      suppliers[idx] = { ...suppliers[idx], ...newSup };
    } else {
      suppliers.push(newSup);
    }
    saveSuppliersList(suppliers);
    res.json({ success: true, supplier: newSup, suppliers });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to save supplier', message: err?.message });
  }
});

app.put('/api/suppliers/:id', requireRole('admin'), (req: Request, res: Response) => {
  try {
    const suppliers = getSuppliersList();
    const { id } = req.params;
    const idx = suppliers.findIndex((s) => s.id === id);
    if (idx === -1) {
      return res.status(404).json({ error: 'Supplier not found' });
    }
    suppliers[idx] = { ...suppliers[idx], ...req.body };
    saveSuppliersList(suppliers);
    res.json({ success: true, supplier: suppliers[idx], suppliers });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update supplier', message: err?.message });
  }
});

// Multi-supplier sync endpoints
const handleSync = async (req: Request, res: Response) => {
  try {
    const result = await executeMultiSupplierSync();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Sync failed' });
  }
};

// جزئیات باکس‌های آماری هر تأمین‌کننده: کالاهای هماهنگ، رنگ‌های هماهنگ، کالاهای مبهم
app.get('/api/suppliers/:id/details', (req: Request, res: Response) => {
  const all = readJsonFile<Record<string, any>>(path.join(DATA_DIR, 'supplier_match_details.json'), {});
  const d = all[req.params.id] || { matched: [], colors: [], ambiguous: [], updatedAt: null };

  const products = readJsonFile<any[]>(getFilePath('products.json'), []);
  const prodMap = new Map<string, any>(products.map((p) => [p.id, p]));

  const getProductColorStr = (p: any): string => {
    if (!p) return 'عمومی / تمام رنگ‌ها';
    if (Array.isArray(p.variants)) {
      const colorVar = p.variants.find((v: any) => v.type === 'color' || v.name === 'رنگ' || v.title?.includes('رنگ'));
      if (colorVar && Array.isArray(colorVar.options) && colorVar.options.length > 0) {
        return colorVar.options.map((o: any) => o.name || o.value || o.title).filter(Boolean).join('، ');
      }
    }
    if (Array.isArray(p.colors) && p.colors.length > 0) {
      return p.colors.map((c: any) => (typeof c === 'string' ? c : c.name || c.title)).filter(Boolean).join('، ');
    }
    if (p.color) return String(p.color);
    return 'عمومی / تمام رنگ‌ها';
  };

  const getColorItems = (product: any, defaultPrice: any) => {
    if (!product) return [];
    const items: { name: string; price: number }[] = [];
    if (Array.isArray(product.variants)) {
      const colorVar = product.variants.find((v: any) => v.type === 'color' || v.name === 'رنگ' || v.title?.includes('رنگ'));
      if (colorVar && Array.isArray(colorVar.options) && colorVar.options.length > 0) {
        for (const o of colorVar.options) {
          const name = String(o.name || o.value || o.title || '').trim();
          if (name) {
            const pr = Number(o.price || (o.priceDelta ? (product.price || 0) + o.priceDelta : defaultPrice) || 0);
            items.push({ name, price: pr || defaultPrice });
          }
        }
      }
    }
    if (items.length === 0 && Array.isArray(product.colors) && product.colors.length > 0) {
      for (const c of product.colors) {
        const name = typeof c === 'string' ? c.trim() : String(c.name || c.title || '').trim();
        if (name) {
          const pr = typeof c === 'object' && c.price ? Number(c.price) : defaultPrice;
          items.push({ name, price: pr || defaultPrice });
        }
      }
    }
    return items;
  };

  const enrichedAmbiguous = (d.ambiguous || []).map((row: any) => {
    const p = prodMap.get(row.productId);
    const pName = row.productName || (p ? (p.persianName || p.name) : row.productId);
    const pColor = row.productColor || row.color || (p ? getProductColorStr(p) : 'عمومی / تمام رنگ‌ها');
    const pPrice = row.productPrice !== undefined ? row.productPrice : (p ? p.price : null);
    const pColorItems = getColorItems(p, pPrice);

    const candidates = (row.candidates || []).map((c: any) => {
      let cColor = c.color;
      if (!cColor || cColor === c.title) {
        cColor = extractColorFromTitle(c.title) || 'پیش‌فرض / نامشخص';
      }
      let cPrice = c.price !== undefined && c.price !== null ? c.price : (c.sourcePrice !== undefined ? c.sourcePrice : null);

      let cColorItems: { name: string; price: number }[] = [];
      if (Array.isArray(c.variants) && c.variants.length > 0) {
        cColorItems = c.variants.map((v: any) => ({
          name: v.name || v.color || v.title,
          price: Number(v.price || v.sourcePrice || cPrice || 0),
        }));
      }

      if (cColorItems.length === 0) {
        const candProduct = products.find(
          (x) =>
            x.id === `prod-ks-${c.id}` ||
            x.id === `prod-ht-${c.id}` ||
            x.id === `prod-eh-${c.id}` ||
            x.id === c.id ||
            x.supplierMatches?.kasra?.supplierProductId === String(c.id) ||
            x.supplierMatches?.hamrahtel?.supplierProductId === String(c.id) ||
            x.name === c.title ||
            x.title === c.title
        );
        if (candProduct) {
          if (!cPrice) cPrice = candProduct.price;
          cColorItems = getColorItems(candProduct, cPrice);
        }
      }

      if (cColorItems.length === 0) {
        const cCols = String(cColor).split(/[،,]/).map((s: string) => s.trim()).filter(Boolean);
        cColorItems = cCols.map((col: string) => ({
          name: col,
          price: cPrice || 0,
        }));
      }

      return {
        ...c,
        color: cColor || 'پیش‌فرض / نامشخص',
        price: cPrice,
        colorItems: cColorItems,
      };
    });

    return {
      ...row,
      productName: pName,
      productColor: pColor,
      productPrice: pPrice,
      productColorItems: pColorItems,
      candidates,
    };
  });

  res.json({ success: true, supplierId: req.params.id, ...d, ambiguous: enrichedAmbiguous });
});

// تأیید دستی یک کالای مبهم: شناسه کالای تأمین‌کننده به کالای پازل کالا «پین» می‌شود و بلافاصله قیمت اعمال می‌گردد
app.post('/api/suppliers/:id/confirm-match', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { productId, supplierProductId } = req.body || {};
    if (!productId || supplierProductId === undefined || supplierProductId === null || supplierProductId === '')
      return res.status(400).json({ success: false, message: 'productId و supplierProductId لازم است.' });
    const products = readJsonFile<any[]>(getFilePath('products.json'), []);
    const p = products.find((x) => x.id === productId);
    if (!p) return res.status(404).json({ success: false, message: 'کالا یافت نشد.' });
    p.supplierMatches = { ...(p.supplierMatches || {}), [req.params.id]: { supplierProductId: String(supplierProductId), confirmedAt: new Date().toISOString(), confirmedBy: 'admin' } };
    writeJsonFile(getFilePath('products.json'), products);

    // اعمال فوری قیمت و موجودی بدون معطلی و بدون انتظار ۵ دقیقه‌ای
    try {
      await executeMultiSupplierSync();
    } catch (syncErr: any) {
      console.error('[PuzzleKala] Immediate sync on confirm-match error:', syncErr?.message);
    }

    res.json({ success: true, message: 'تطبیق تأیید شد و قیمت و موجودی بلافاصله اعمال گردید.' });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message });
  }
});

// ثبت یا به‌روزرسانی نام کاربری و کلمه عبور سایت تأمین‌کننده
app.post('/api/suppliers/:id/credentials', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { username, password, baseUrl } = req.body || {};
    const suppliers = getSuppliersList();
    const sup = suppliers.find((s) => s.id === req.params.id);
    if (!sup) {
      return res.status(404).json({ success: false, message: 'تأمین‌کننده یافت نشد.' });
    }
    if (username !== undefined) sup.username = String(username).trim();
    if (password !== undefined) sup.password = String(password);
    if (baseUrl !== undefined && String(baseUrl).trim()) sup.baseUrl = String(baseUrl).trim();

    saveSuppliersList(suppliers);

    if (sup.id === 'hamrahtel') {
      clearHamrahTelTokenCache();
    }

    recordAuditLog(
      'supplier_credentials_update',
      `اطلاعات ورود برای تأمین‌کننده «${sup.name}» به‌روزرسانی شد.`,
      'admin-ui',
      { supplierId: sup.id }
    );

    // اجرای استعلام زنده بلافاصله با اطلاعات ورود جدید
    let syncError: string | null = null;
    try {
      await executeMultiSupplierSync();
    } catch (e: any) {
      syncError = e?.message || null;
    }

    const updatedList = getSuppliersList();
    const updatedSup = updatedList.find((s) => s.id === req.params.id) || sup;

    res.json({
      success: true,
      message: 'نام کاربری و کلمه عبور با موفقیت ذخیره شد و استعلام زنده انجام گرفت.',
      supplier: updatedSup,
      syncError,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message || 'خطا در ثبت اطلاعات' });
  }
});

// تأیید دستی یک جهش قیمت نگه‌داشته‌شده: دور بعدی همگام‌سازی همان قیمت تأمین‌کننده را اعمال می‌کند
app.post('/api/suppliers/approve-price-jump', requireRole('admin'), (req: Request, res: Response) => {
  try {
    const { productId, color, sourcePrice } = req.body || {};
    const sp = Number(sourcePrice);
    if (!productId || !(sp > 0)) return res.status(400).json({ success: false, message: 'productId و sourcePrice (عدد مثبت) لازم است.' });
    const products = readJsonFile<any[]>(getFilePath('products.json'), []);
    const p = products.find((x) => x.id === productId);
    if (!p) return res.status(404).json({ success: false, message: 'کالا یافت نشد.' });
    if (color) {
      const grp = (Array.isArray(p.variants) ? p.variants : []).find((v: any) => v.type === 'color' || v.name === 'رنگ');
      const opt = grp && Array.isArray(grp.options) ? grp.options.find((o: any) => o.name === color || normalizeColor(o.name) === normalizeColor(color)) : null;
      if (!opt) return res.status(404).json({ success: false, message: 'رنگ یافت نشد.' });
      opt.approvedSourcePrice = sp;
    } else {
      p.approvedSourcePrice = sp;
    }
    writeJsonFile(getFilePath('products.json'), products);
    res.json({ success: true, message: 'قیمت تأیید شد؛ در همگام‌سازی بعدی (حداکثر ۵ دقیقه) اعمال می‌شود.' });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message });
  }
});

app.post('/api/suppliers/sync', handleSync);
app.post('/api/suppliers/sync-all', handleSync);
app.post('/api/kasra/sync-now', handleSync);

app.get('/api/suppliers/status', (req: Request, res: Response) => {
  const sups = getSuppliersList();
  res.json({ suppliers: sups, connectedCount: sups.filter((s) => s.status === 'connected').length });
});

app.get('/api/sync/status', (req: Request, res: Response) => {
  const sups = getSuppliersList();
  res.json({
    success: true,
    version: {
      overall: 1,
      products: 1,
      orders: 1,
      settings: 1,
      coupons: 1,
      users: 1,
    },
    suppliers: sups,
    lastSyncAt: sups[0]?.lastSyncAt || null,
  });
});

app.get('/api/sync/bundle', requireRole('admin', 'customer'), (req: Request, res: Response) => {
  try {
    const rawProducts = readJsonFile<any[]>(getFilePath('products.json'), []);
    const products = rawProducts
      .map(sanitizeProduct)
      .filter(Boolean)
      .filter(isUserRegisteredProduct);
    const allOrders = readJsonFile<any[]>(getFilePath('orders.json'), []);
    const sess = getSession(req);
    const orders = sess?.role === 'admin'
      ? allOrders
      : allOrders.filter((o) => String(o.userId || o.customerId || o.user?.id || '') === String(sess?.userId || ''));
    const rawSettings = readJsonFile<any>(getFilePath('settings.json'), {});
    const { adminPassword, adminToken, apiKey, secret, ...settings } = rawSettings;
    const coupons = flattenCoupons(readJsonFile<any[]>(getFilePath('coupons.json'), []));
    const users = visibleUsers(req);
    res.json({
      success: true,
      data: {
        products,
        orders,
        settings,
        coupons,
        users,
      },
      version: {
        overall: 1,
        products: 1,
        orders: 1,
        settings: 1,
        coupons: 1,
        users: 1,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Failed to build sync bundle', message: err?.message });
  }
});

app.get('/api/kasra/status', requireRole('admin'), (req: Request, res: Response) => {
  const sups = getSuppliersList();
  const kasra = sups.find((s) => s.id === 'kasra') || sups[0];
  res.json({
    success: true,
    connected: kasra ? Boolean(kasra.enabled && kasra.status === 'connected') : false,
    kasra,
  });
});

app.get('/api/kasra/stats', requireRole('admin'), (req: Request, res: Response) => {
  const sups = getSuppliersList();
  const kasra = sups.find((s) => s.id === 'kasra') || sups[0];
  const settings = readJsonFile<any>(getFilePath('settings.json'), {});
  const markupPercentage = Number(settings.supplierMarkupPercent ?? 5);

  const totalCatalogCount = kasra?.sourceTotalProducts ?? 0;
  const inStockCount = kasra?.sourceInStockProducts ?? 0;
  const outOfStockCount = kasra?.sourceOutOfStockProducts ?? Math.max(0, totalCatalogCount - inStockCount);

  res.json({
    success: true,
    totalCatalogCount,
    inStockCount,
    outOfStockCount,
    markupPercentage,
    totalProducts: totalCatalogCount,
    inStockProducts: inStockCount,
    outOfStockProducts: outOfStockCount,
    matchedProducts: kasra?.matchedCount || 0,
    matchedCount: kasra?.matchedCount || 0,
    inStockColorsCount: kasra?.inStockColorsCount || 0,
    status: kasra?.status || 'unknown',
    connected: kasra ? kasra.enabled !== false && kasra.status === 'connected' : false,
    lastSyncAt: kasra?.lastSyncAt || null,
    suppliers: sups,
    kasra,
  });
});

// 4. Settings
app.get('/api/settings', (req: Request, res: Response) => {
  try {
    const settings = readJsonFile<any>(getFilePath('settings.json'), {});
    const sess = getSession(req);
    if (sess?.role === 'admin') return res.json(settings);
    const { adminPassword, adminToken, apiKey, secret, ...publicSettings } = settings;
    res.json(publicSettings);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to read settings', message: err?.message });
  }
});

const handleSettingsUpdate = (req: Request, res: Response) => {
  try {
    const current = readJsonFile<any>(getFilePath('settings.json'), {});
    const updated = { ...current, ...req.body };
    writeJsonFile(getFilePath('settings.json'), updated);
    res.json({ success: true, settings: updated });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to save settings', message: err?.message });
  }
};

app.post('/api/settings', requireRole('admin'), handleSettingsUpdate);
app.put('/api/settings', requireRole('admin'), handleSettingsUpdate);

// 5. Orders
app.get('/api/orders', requireRole('admin', 'customer'), (req: Request, res: Response) => {
  try {
    const orders = readJsonFile<any[]>(getFilePath('orders.json'), []);
    const sess = getSession(req);
    if (sess?.role === 'admin') return res.json(orders);
    const mine = orders.filter((o) => String(o.userId || o.customerId || o.user?.id || '') === String(sess?.userId || ''));
    res.json(mine);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to read orders', message: err?.message });
  }
});

app.post('/api/orders', requireRole('admin', 'customer'), (req: Request, res: Response) => {
  try {
    const orders = readJsonFile<any[]>(getFilePath('orders.json'), []);
    const newOrder = { ...(req.body || {}) };
    const sess = getSession(req);
    if (sess?.role === 'customer') newOrder.userId = sess.userId;
    if (!newOrder.id) {
      newOrder.id = `ord-${Date.now()}`;
    }
    newOrder.createdAt = newOrder.createdAt || new Date().toISOString();
    orders.unshift(newOrder);
    writeJsonFile(getFilePath('orders.json'), orders);
    res.json({ success: true, order: newOrder });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to save order', message: err?.message });
  }
});

app.put('/api/orders/:id', requireRole('admin'), (req: Request, res: Response) => {
  try {
    const orders = readJsonFile<any[]>(getFilePath('orders.json'), []);
    const { id } = req.params;
    const idx = orders.findIndex((o) => o.id === id);
    if (idx === -1) {
      return res.status(404).json({ error: 'Order not found' });
    }
    orders[idx] = { ...orders[idx], ...req.body, updatedAt: new Date().toISOString() };
    writeJsonFile(getFilePath('orders.json'), orders);
    res.json({ success: true, order: orders[idx] });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update order', message: err?.message });
  }
});

app.delete('/api/orders/:id', requireRole('admin'), (req: Request, res: Response) => {
  try {
    let orders = readJsonFile<any[]>(getFilePath('orders.json'), []);
    const { id } = req.params;
    orders = orders.filter((o) => o.id !== id);
    writeJsonFile(getFilePath('orders.json'), orders);
    res.json({ success: true, message: 'Order deleted' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Failed to delete order', message: err?.message });
  }
});

// 6. Users & Auth
// کاربران: مدیر لیست کامل (بدون رمز) می‌بیند؛ مشتری فقط رکورد خودش؛ بقیه هیچ.
function visibleUsers(req: Request): any[] {
  const sess = getSession(req);
  const users = readJsonFile<any[]>(getFilePath('users.json'), []);
  if (!sess) return [];
  if (sess.role === 'admin') return users.map(publicUser);
  if (sess.role === 'customer') return users.filter((u) => u.id === sess.userId).map(publicUser);
  return [];
}

app.get('/api/users', requireRole('admin', 'customer'), (req: Request, res: Response) => {
  try {
    res.json(visibleUsers(req));
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to read users', message: err?.message });
  }
});

app.delete(['/api/users/:id', '/api/users.php'], requireRole('admin'), (req: Request, res: Response) => {
  try {
    const id = req.params.id || (req.query.id as string);
    let users = readJsonFile<any[]>(getFilePath('users.json'), []);
    users = users.filter((u) => u.id !== id);
    writeJsonFile(getFilePath('users.json'), users);
    res.json({ success: true, message: 'User deleted' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Failed to delete user', message: err?.message });
  }
});

const findCustomer = (users: any[], identifier: string) => {
  const raw = String(identifier || '').trim();
  const d = digits(raw);
  return users.find((u) => {
    if (u.role === 'admin') return false;
    if (d && u.nationalCode && digits(u.nationalCode) === d) return true;
    if (u.username && String(u.username).toLowerCase() === raw.toLowerCase()) return true;
    if (u.email && String(u.email).toLowerCase() === raw.toLowerCase()) return true;
    if (d.length >= 7 && u.phone) { const p = digits(u.phone); return p.endsWith(d.slice(-10)) || d.endsWith(p.slice(-10)); }
    return false;
  });
};

app.post('/api/auth/login', authRateLimit(8), (req: Request, res: Response) => {
  try {
    const { identifier, phone, nationalCode, password } = req.body || {};
    const users = readJsonFile<any[]>(getFilePath('users.json'), []);
    const user = findCustomer(users, identifier || phone || nationalCode);
    if (!user) return res.status(401).json({ success: false, message: 'کاربری با این مشخصات یافت نشد.' });
    if (!user.password) return res.status(401).json({ success: false, message: 'برای این حساب رمز عبور تنظیم نشده است. با پشتیبانی تماس بگیرید.' });
    if (!verifyPassword(user.password, password)) return res.status(401).json({ success: false, message: 'کلمه عبور وارد شده نادرست است.' });
    if (!isHashed(user.password)) { // ارتقای رمز قدیمی به هش
      user.password = hashPassword(String(password));
      writeJsonFile(getFilePath('users.json'), users);
    }
    if (user.isActive === false) return res.status(403).json({ success: false, message: 'حساب کاربری غیرفعال است.' });
    res.json({ success: true, user: publicUser(user), token: createSession('customer', { userId: user.id, username: user.username }) });
  } catch (err: any) {
    res.status(500).json({ error: 'Login error', message: err?.message });
  }
});

app.post('/api/auth/register', authRateLimit(5), (req: Request, res: Response) => {
  try {
    const users = readJsonFile<any[]>(getFilePath('users.json'), []);
    const body = req.body || {};
    const phone = digits(body.phone), nc = digits(body.nationalCode);
    if (!body.password || String(body.password).length < 4) return res.status(400).json({ success: false, message: 'رمز عبور باید حداقل ۴ کاراکتر باشد.' });
    if (phone && users.some((u) => u.phone && digits(u.phone).slice(-10) === phone.slice(-10)))
      return res.status(409).json({ success: false, message: 'این شماره تماس قبلاً ثبت شده است.' });
    if (nc && users.some((u) => u.nationalCode && digits(u.nationalCode) === nc))
      return res.status(409).json({ success: false, message: 'این کد ملی قبلاً ثبت شده است.' });
    const newUser = {
      ...body,
      id: `usr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      role: 'customer',          // نقش را فقط سرور تعیین می‌کند
      isActive: true,
      walletBalance: 0,          // موجودی کیف پول از کلاینت پذیرفته نمی‌شود
      password: hashPassword(String(body.password)),
    };
    users.push(newUser);
    writeJsonFile(getFilePath('users.json'), users);
    res.json({ success: true, user: publicUser(newUser), token: createSession('customer', { userId: newUser.id, username: newUser.username }) });
  } catch (err: any) {
    res.status(500).json({ error: 'Register error', message: err?.message });
  }
});

// بازیابی رمز مدیر: ADMIN_RESET_PASSWORD (و اختیاری ADMIN_RESET_USERNAME) را در .env بگذارید و سرور را یک بار بالا بیاورید.
(function applyAdminReset() {
  const pw = process.env.ADMIN_RESET_PASSWORD;
  if (!pw) return;
  try {
    const users = readJsonFile<any[]>(getFilePath('users.json'), []);
    const name = process.env.ADMIN_RESET_USERNAME || 'admin';
    let admin = users.find((u) => u.role === 'admin' && (u.username === name || u.phone === name)) || users.find((u) => u.role === 'admin');
    if (!admin) { admin = { id: 'admin', name: 'مدیر فروشگاه', username: name, role: 'admin', isActive: true }; users.push(admin); }
    admin.password = hashPassword(pw);
    writeJsonFile(getFilePath('users.json'), users);
    console.log('[Auth] رمز مدیر بازنشانی شد. ADMIN_RESET_PASSWORD را از .env حذف کنید.');
  } catch (e: any) { console.error('[Auth] admin reset failed:', e?.message); }
})();

app.post('/api/admin/login', authRateLimit(6), (req: Request, res: Response) => {
  const { username, password } = req.body || {};
  const users = readJsonFile<any[]>(getFilePath('users.json'), []);
  const admin = users.find((u) => u.role === 'admin' && (u.username === username || u.phone === username));
  if (admin && verifyPassword(admin.password, password)) {
    if (!isHashed(admin.password)) { admin.password = hashPassword(String(password)); writeJsonFile(getFilePath('users.json'), users); }
    return res.json({ success: true, token: createSession('admin', { userId: admin.id, username: admin.username }), user: publicUser(admin) });
  }
  return res.status(401).json({ success: false, message: 'نام کاربری یا رمز عبور اشتباه است' });
});

app.post('/api/admin/clear-data', requireRole('admin'), (req: Request, res: Response) => {
  try {
    writeJsonFile(getFilePath('orders.json'), []);
    writeJsonFile(getFilePath('tickets.json'), []);
    writeJsonFile(getFilePath('sms_logs.json'), []);
    writeJsonFile(getFilePath('wallet_transactions.json'), []);
    res.json({ success: true, message: 'تمامی اطلاعات قبلی با موفقیت پاکسازی شدند! فروشگاه آماده است.' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message });
  }
});

app.post('/api/admin/change-credentials', requireRole('admin'), (req: Request, res: Response) => {
  try {
    const { newUsername, newPassword } = req.body || {};
    const sess = getSession(req);
    const users = readJsonFile<any[]>(getFilePath('users.json'), []);
    const idx = users.findIndex((u) => u.role === 'admin' && (!sess?.userId || u.id === sess.userId));
    if (idx < 0) return res.status(404).json({ success: false, message: 'مدیر یافت نشد' });
    if (newUsername) users[idx].username = String(newUsername);
    if (newPassword) {
      if (String(newPassword).length < 8) return res.status(400).json({ success: false, message: 'رمز جدید باید حداقل ۸ کاراکتر باشد.' });
      users[idx].password = hashPassword(String(newPassword));
    }
    writeJsonFile(getFilePath('users.json'), users);
    // پس از تغییر اعتبارنامه، نشست‌های قبلی این مدیر دیگر معتبر نیستند.
    const revoked = revokeUserSessions(users[idx].id, 'admin');
    // یک نشست تازه صادر می‌کنیم تا مدیر از پنل خارج نشود.
    const token = createSession('admin', { userId: users[idx].id, username: users[idx].username });
    res.json({ success: true, token, user: publicUser(users[idx]), revokedSessions: revoked, message: 'اطلاعات با موفقیت تغییر کرد' });
  } catch (err: any) {
    res.status(500).json({ error: 'Error changing credentials', message: err?.message });
  }
});

// 7. Coupons
app.get('/api/coupons', (req: Request, res: Response) => {
  try {
    res.json(flattenCoupons(readJsonFile<any[]>(getFilePath('coupons.json'), [])));
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to read coupons', message: err?.message });
  }
});

// اصلاح باگ تو در تو شدن کوپن‌ها: فرانت‌اند کل لیست را به شکل { coupons: [...] } ارسال می‌کند
const flattenCoupons = (input: any): any[] => {
  const out: any[] = [];
  const walk = (x: any) => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') {
      if (Array.isArray(x.coupons)) walk(x.coupons);
      else if (x.code || x.id) out.push(x);
    }
  };
  walk(input);
  const seen = new Set<string>();
  return out.filter((c) => { const k = String(c.id ?? c.code); if (seen.has(k)) return false; seen.add(k); return true; });
};

app.post('/api/coupons', requireRole('admin'), (req: Request, res: Response) => {
  try {
    const body = req.body;
    let coupons: any[];
    if (body && Array.isArray(body.coupons)) {
      coupons = flattenCoupons(body.coupons); // ذخیره کل لیست (جایگزینی)
    } else {
      const current = flattenCoupons(readJsonFile<any[]>(getFilePath('coupons.json'), []));
      const k = String(body?.id ?? body?.code);
      coupons = [...current.filter((c) => String(c.id ?? c.code) !== k), ...flattenCoupons(body)];
    }
    writeJsonFile(getFilePath('coupons.json'), coupons);
    res.json({ success: true, coupons });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to save coupon', message: err?.message });
  }
});

// 8. Banners
app.get('/api/banners', (req: Request, res: Response) => {
  try {
    const banners = readJsonFile<any[]>(getFilePath('banners.json'), []);
    res.json(banners);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to read banners', message: err?.message });
  }
});

// 9. Tickets
app.get('/api/tickets', requireRole('admin', 'customer'), (req: Request, res: Response) => {
  try {
    const tickets = readJsonFile<any[]>(getFilePath('tickets.json'), []);
    const sess = getSession(req);
    if (sess?.role === 'admin') return res.json(tickets);
    res.json(tickets.filter((t) => String(t.userId || t.customerId || t.user?.id || '') === String(sess?.userId || '')));
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to read tickets', message: err?.message });
  }
});

app.post('/api/tickets', requireRole('admin', 'customer'), (req: Request, res: Response) => {
  try {
    const tickets = readJsonFile<any[]>(getFilePath('tickets.json'), []);
    const sess = getSession(req);
    const newTicket = { ...(req.body || {}) };
    if (sess?.role === 'customer') newTicket.userId = sess.userId;
    if (!newTicket.id) {
      newTicket.id = `tck-${Date.now()}`;
    }
    tickets.unshift(newTicket);
    writeJsonFile(getFilePath('tickets.json'), tickets);
    res.json({ success: true, ticket: newTicket });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to save ticket', message: err?.message });
  }
});

app.put('/api/tickets/:id', requireRole('admin'), (req: Request, res: Response) => {
  try {
    const tickets = readJsonFile<any[]>(getFilePath('tickets.json'), []);
    const { id } = req.params;
    const idx = tickets.findIndex((t) => t.id === id);
    if (idx !== -1) {
      tickets[idx] = { ...tickets[idx], ...req.body, updatedAt: new Date().toISOString() };
      writeJsonFile(getFilePath('tickets.json'), tickets);
      return res.json({ success: true, ticket: tickets[idx] });
    }
    res.status(404).json({ success: false, error: 'Ticket not found' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message });
  }
});

app.post('/api/tickets/:id/reply', requireRole('admin'), (req: Request, res: Response) => {
  try {
    const tickets = readJsonFile<any[]>(getFilePath('tickets.json'), []);
    const { id } = req.params;
    const idx = tickets.findIndex((t) => t.id === id);
    const { message, status } = req.body;
    if (idx !== -1) {
      if (!Array.isArray(tickets[idx].messages)) {
        tickets[idx].messages = [];
      }
      tickets[idx].messages.push({
        id: `msg-${Date.now()}`,
        sender: 'support',
        message: message || '',
        createdAt: new Date().toISOString(),
      });
      if (status) tickets[idx].status = status;
      tickets[idx].updatedAt = new Date().toISOString();
      writeJsonFile(getFilePath('tickets.json'), tickets);
      return res.json({ success: true, ticket: tickets[idx] });
    }
    res.status(404).json({ success: false, error: 'Ticket not found' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message });
  }
});

// 10. Wallet
app.get('/api/wallet/transactions', requireRole('admin', 'customer'), (req: Request, res: Response) => {
  try {
    const txs = readJsonFile<any[]>(getFilePath('wallet_transactions.json'), []);
    const sess = getSession(req);
    if (sess?.role === 'admin') return res.json(txs);
    res.json(txs.filter((t) => String(t.userId || '') === String(sess?.userId || '')));
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to read transactions', message: err?.message });
  }
});

app.post('/api/wallet/adjust', requireRole('admin'), (req: Request, res: Response) => {
  try {
    const txs = readJsonFile<any[]>(getFilePath('wallet_transactions.json'), []);
    const { userId, amount, description } = req.body || {};
    const numericAmount = Number(amount);
    if (!userId || !Number.isFinite(numericAmount) || numericAmount === 0 || Math.abs(numericAmount) > 1_000_000_000) {
      return res.status(400).json({ success: false, message: 'شناسه کاربر و مبلغ معتبر لازم است.' });
    }
    const newTx = {
      id: `tx-${Date.now()}`,
      userId: String(userId),
      amount: numericAmount,
      description,
      createdAt: new Date().toISOString(),
    };
    txs.unshift(newTx);
    writeJsonFile(getFilePath('wallet_transactions.json'), txs);

    const users = readJsonFile<any[]>(getFilePath('users.json'), []);
    const uIdx = users.findIndex((u) => u.id === userId);
    if (uIdx >= 0) {
      users[uIdx].walletBalance = Number(users[uIdx].walletBalance || 0) + numericAmount;
      writeJsonFile(getFilePath('users.json'), users);
    }
    res.json({ success: true, transaction: newTx });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to adjust wallet', message: err?.message });
  }
});

// 11. SMS
app.get('/api/sms/history', requireRole('admin'), (req: Request, res: Response) => {
  try {
    const logs = readJsonFile<any[]>(getFilePath('sms_logs.json'), []);
    res.json(logs);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to read sms logs', message: err?.message });
  }
});

app.post('/api/sms/send', requireRole('admin'), (req: Request, res: Response) => {
  try {
    const logs = readJsonFile<any[]>(getFilePath('sms_logs.json'), []);
    const newLog = {
      id: `sms-${Date.now()}`,
      ...req.body,
      status: 'recorded_not_sent',
      sentAt: new Date().toISOString(),
    };
    logs.unshift(newLog);
    writeJsonFile(getFilePath('sms_logs.json'), logs);
    res.json({ success: true, log: newLog });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to send sms', message: err?.message });
  }
});

// 12. Accounting Module
const ACC_USERS = () => path.join(DATA_DIR, 'accounting', 'users.json');

app.get('/api/accounting/users', requireRole('accounting'), (req: Request, res: Response) => {
  try {
    const accUsers = readJsonFile<any[]>(ACC_USERS(), []).map(publicUser);
    res.json({ success: true, users: accUsers });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Failed to read accounting users', message: err?.message, users: [] });
  }
});

app.post('/api/accounting/users', requireRole('admin'), (req: Request, res: Response) => {
  try {
    const accUsers = readJsonFile<any[]>(ACC_USERS(), []);
    const { id, username, fullName, role, password } = req.body || {};
    let user: any;
    if (id) {
      const idx = accUsers.findIndex((u) => u.id === id);
      if (idx >= 0) {
        const { password: _p, ...rest } = req.body;
        accUsers[idx] = { ...accUsers[idx], ...rest };
        if (password) accUsers[idx].password = isHashed(password) ? password : hashPassword(String(password));
        user = accUsers[idx];
      }
    }
    if (!user) {
      if (!password) return res.status(400).json({ success: false, message: 'رمز عبور لازم است.' });
      user = {
        id: id || `usr_acc_${Date.now()}`,
        username: username || `user_${Date.now()}`,
        fullName: fullName || 'کاربر حسابداری',
        role: role || 'اپراتور',
        createdAt: new Date().toLocaleDateString('fa-IR'),
        password: hashPassword(String(password)),
      };
      accUsers.push(user);
    }
    writeJsonFile(ACC_USERS(), accUsers);
    res.json({ success: true, message: `کاربر ${user.username} با موفقیت در سرور ذخیره شد.`, user: publicUser(user) });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message });
  }
});

app.delete('/api/accounting/users', requireRole('admin'), (req: Request, res: Response) => {
  try {
    const id = req.query.id as string;
    let accUsers = readJsonFile<any[]>(ACC_USERS(), []);
    accUsers = accUsers.filter((u) => u.id !== id);
    writeJsonFile(ACC_USERS(), accUsers);
    res.json({ success: true, message: 'کاربر مورد نظر با موفقیت از سرور حذف شد.' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message });
  }
});

app.post('/api/accounting/auth/login', authRateLimit(8), (req: Request, res: Response) => {
  try {
    const { username, password } = req.body || {};
    const accUsers = readJsonFile<any[]>(ACC_USERS(), []);
    const user = accUsers.find((u) => u.username === username);
    if (user && verifyPassword(user.password, password)) {
      if (!isHashed(user.password)) { user.password = hashPassword(String(password)); writeJsonFile(ACC_USERS(), accUsers); }
      return res.json({ success: true, user: publicUser(user), token: createSession('accounting', { userId: user.id, username: user.username }) });
    }
    return res.status(401).json({ success: false, message: 'نام کاربری یا رمز عبور حسابداری اشتباه است' });
  } catch (err: any) {
    res.status(500).json({ error: 'Accounting login error', message: err?.message });
  }
});

app.get('/api/accounting/user-data', requireRole('accounting'), (req: Request, res: Response) => {
  try {
    const sess = getSession(req);
    const requestedUsername = (req.query.username as string) || sess?.username || 'admin';
    if (sess?.role !== 'admin' && requestedUsername !== sess?.username) return res.status(403).json({ success: false, message: 'دسترسی به اطلاعات کاربر دیگر مجاز نیست.' });
    const safeUser = String(requestedUsername).replace(/[^a-zA-Z0-9_\-]/g, '');
    const userFile = path.join(DATA_DIR, 'accounting', 'users', `${safeUser}.json`);
    const fallbackFile = path.join(DATA_DIR, 'accounting', 'users', 'admin.json');
    let data: any = {};
    if (fs.existsSync(userFile)) {
      data = readJsonFile<any>(userFile, {});
    } else if (fs.existsSync(fallbackFile)) {
      data = readJsonFile<any>(fallbackFile, {});
    }
    res.json({ success: true, data });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Accounting data error', message: err?.message });
  }
});

app.post('/api/accounting/user-data', requireRole('accounting'), (req: Request, res: Response) => {
  try {
    const { username, data } = req.body || {};
    const sess = getSession(req);
    const requestedUsername = String(username || sess?.username || 'admin');
    if (sess?.role !== 'admin' && requestedUsername !== sess?.username) return res.status(403).json({ success: false, message: 'دسترسی به اطلاعات کاربر دیگر مجاز نیست.' });
    const safeUser = requestedUsername.replace(/[^a-zA-Z0-9_\-]/g, '');
    const userDir = path.join(DATA_DIR, 'accounting', 'users');
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }
    const filePath = path.join(userDir, `${safeUser}.json`);
    const updatedAt = new Date().toISOString();
    writeJsonFile(filePath, { ...data, updatedAt });
    res.json({ success: true, updatedAt });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message });
  }
});

// 13. Audit Logs
app.get('/api/audit-logs', requireRole('admin'), (req: Request, res: Response) => {
  try {
    const logs = readJsonFile<any[]>(getFilePath('audit_logs.json'), []);
    res.json(logs);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to read audit logs', message: err?.message });
  }
});

// 14. AI Assistant Endpoints
app.post('/api/ai/chat', async (req: Request, res: Response) => {
  const fallback = 'درود! در فروشگاه پازل کالا در خدمت شما هستیم. اگر درباره مشخصات فنی کالاها، مقایسه یا رنج قیمت سؤالی دارید، بفرمایید.';
  try {
    const msg = String(req.body?.message ?? req.body?.query ?? '').trim();
    if (!msg || assistantRateLimited(`chat:${req.ip}`)) return res.json({ success: true, reply: fallback, summary: fallback });
    const r = await runShoppingAssistant(readJsonFile<any[]>(getFilePath('products.json'), []), msg);
    const rep = r.ok && r.summary ? r.summary : fallback;
    res.json({ success: true, reply: rep, summary: rep, products: r.products || [] });
  } catch {
    res.json({ success: true, reply: fallback, summary: fallback, products: [] });
  }
});

// ثبت هوشمند کالا: فقط مدیر، با محدودیت تعداد درخواست (جلوگیری از مصرف بی‌رویه سهمیه هوش مصنوعی)
const smartHits = new Map<string, number[]>();
app.post('/api/ai/parse-product', requireAdminOrBridge, async (req: Request, res: Response) => {
  const key = String(req.headers.authorization || req.ip);
  const now = Date.now();
  const hits = (smartHits.get(key) || []).filter((t) => now - t < 60000);
  if (hits.length >= 8) return res.status(429).json({ success: false, message: 'تعداد درخواست ثبت هوشمند زیاد است؛ یک دقیقه صبر کنید.' });
  smartHits.set(key, [...hits, now]);
  const query = String(req.body?.query || '').trim().slice(0, 200);
  if (!query) return res.status(400).json({ success: false, message: 'نام یا مدل کالا را وارد کنید.' });
  try {
    const out = await smartRegister(query);
    res.status(out.success ? 200 : 422).json(out);
  } catch (err: any) {
    console.error('[smartRegister]', err?.message || err);
    res.status(500).json({ success: false, message: 'خطای غیرمنتظره در ثبت هوشمند؛ دوباره تلاش کنید.' });
  }
});

// دستیار هوشمند خرید مشتری: فقط از کالاهای واقعی و موجود فروشگاه پیشنهاد می‌دهد.
app.post(['/api/ai/shopping-assistant', '/api/ai/shop-consult'], async (req: Request, res: Response) => {
  try {
    if (assistantRateLimited(`shop:${req.ip}`)) {
      return res.status(429).json({ success: false, message: 'تعداد درخواست‌ها زیاد است؛ کمی بعد دوباره تلاش کنید.' });
    }
    const { query, message, budget, priority, brand } = req.body || {};
    const q = String(query || message || '').trim();
    const r = await runShoppingAssistant(readJsonFile<any[]>(getFilePath('products.json'), []), q, { budget, priority, brand });
    if (!r.ok) return res.status(503).json({ success: false, message: r.error || 'دستیار در دسترس نیست.' });
    res.json({ success: true, summary: r.summary, reply: r.summary, products: r.products || [] });
  } catch (err: any) {
    res.status(500).json({ success: false, message: 'خطای غیرمنتظره در دستیار خرید.' });
  }
});

// 15. API Catch-All: Guarantee valid JSON for all /api/* requests
app.all('/api/*', (req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: `API route not found: ${req.method} ${req.path}`,
    version: {
      overall: 1,
      products: 1,
      orders: 1,
      settings: 1,
      coupons: 1,
      users: 1,
    },
    data: {},
    suppliers: [],
    products: [],
    orders: [],
    users: [],
    settings: {},
    coupons: [],
    tickets: [],
  });
});

// --------------------------------------------------------------------------
// Start Server with Vite Middleware
// --------------------------------------------------------------------------

async function startServer() {
  // Serve public static assets
  app.use(express.static(path.join(__dirname, 'public')));

  const isProduction = process.env.NODE_ENV === 'production';

  if (!isProduction) {
    // Mount Vite dev server in middleware mode
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // In production, serve dist folder or fallback to index.html
    const distPath = path.join(__dirname, 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (req: Request, res: Response) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    } else {
      app.get('*', (req: Request, res: Response) => {
        res.sendFile(path.join(__dirname, 'index.html'));
      });
    }
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[PuzzleKala] Dev server running at http://localhost:${PORT}`);
    // Start 30-second multi-supplier synchronization loop
    try {
      // چرخه ۵ دقیقه‌ای: همگام‌سازی تأمین‌کنندگان ← بروزرسانی قیمت سایت ← پایش و هشدار
      startAgents();
      console.log(`[PuzzleKala] Supplier sync + agents cycle initialized.`);
    } catch (err) {
      console.error('[PuzzleKala] Failed to initialize supplier loop:', err);
    }
  });

  const shutdown = () => {
    console.log('[PuzzleKala] Shutting down server gracefully...');
    server.close(() => {
      console.log('[PuzzleKala] Closed.');
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

startServer().catch((err) => {
  console.error('[PuzzleKala] Failed to start server:', err);
  process.exit(1);
});
