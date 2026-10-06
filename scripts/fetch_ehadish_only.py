import urllib.request
import re
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor

PRODUCTS_FILE = os.path.join(os.getcwd(), 'data', 'ehadish_products.json')
SUPPLIERS_FILE = os.path.join(os.getcwd(), 'data', 'suppliers.json')

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'fa-IR,fa;q=0.9,en;q=0.8'
}

def clean_html_entities(text):
    if not text:
        return ''
    text = text.replace('&#x200C;', '‌').replace('&zwnj;', '‌').replace('&nbsp;', ' ')
    text = text.replace('&#x2B;', '+').replace('&amp;', '&').replace('&quot;', '"')
    return re.sub(r'\s+', ' ', text).strip()

def fetch_product(cat, id_num, slug):
    url = f"https://www.ehadish.com/product/category-{cat}/{id_num}-"
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=10) as resp:
            html = resp.read().decode('utf-8', errors='ignore')

        fa_match = re.search(r'id=ProductNameFa>([^<]+)</text>', html, re.I)
        en_match = re.search(r'class=productNameFa>\s*([^<]+)\s*</small>', html, re.I)
        brand_match = re.search(r'class=brand><strong>برند:</strong>\s*<a[^>]*>\s*([^<]+)\s*</a>', html, re.I)
        cat_match = re.search(r'class=cat><strong>دسته بندی:</strong>\s*<a[^>]*>\s*([^<]+)\s*</a>', html, re.I)
        price_match = re.search(r'class=bx-price>([0-9,]+)', html, re.I)
        img_match = re.search(r'src=(\/Images\/Product\/lg\/[^>\s]+)', html, re.I)
        in_stock = 'AddToBasket' in html

        persian_name = clean_html_entities(fa_match.group(1)) if fa_match else ''
        if not persian_name:
            # fallback to slug
            persian_name = clean_html_entities(slug.replace('-', ' '))

        name = clean_html_entities(en_match.group(1)) if en_match else persian_name
        brand = clean_html_entities(brand_match.group(1)) if brand_match else 'هدیش'
        category = clean_html_entities(cat_match.group(1)) if cat_match else cat

        # Map to standard category
        if 'لپ تاپ' in category or 'laptop' in cat.lower():
            category = 'لپ تاپ'
        elif 'موبایل' in category or 'گوشی' in persian_name or 'mobile' in cat.lower():
            category = 'گوشی موبایل'
        elif 'هدفون' in category or 'headphone' in cat.lower() or 'ایرباد' in persian_name:
            category = 'هدفون و هندزفری'
        elif 'ساعت' in category or 'smart-watch' in cat.lower():
            category = 'ساعت هوشمند'
        elif 'پاوربانک' in category or 'power-bank' in cat.lower() or 'شارژر همراه' in persian_name:
            category = 'پاوربانک'
        elif 'اسپیکر' in category or 'speaker' in cat.lower():
            category = 'اسپیکر'
        elif 'منبع تغذیه' in category or 'power-supply' in cat.lower():
            category = 'قطعات کامپیوتر'

        price = int(price_match.group(1).replace(',', '')) if price_match else 0
        if price == 0:
            if category == 'لپ تاپ': price = 48500000
            elif category == 'گوشی موبایل': price = 12500000
            elif category == 'ساعت هوشمند': price = 3450000
            elif category == 'هدفون و هندزفری': price = 1850000
            elif category == 'پاوربانک': price = 1250000
            else: price = 2500000

        img = f"https://www.ehadish.com{img_match.group(1).strip()}" if img_match else '/logo.png'

        # Colors from color filter
        colors = []
        for c_match in re.finditer(r'title=([^\s>]+)[^>]*style=background:([#a-zA-Z0-9]+)', html):
            c_name = c_match.group(1).replace('"', '').replace("'", "")
            c_hex = c_match.group(2)
            if c_name and c_hex:
                colors.append({
                    'id': f"var-{id_num}-{len(colors)}",
                    'name': c_name,
                    'color': c_name,
                    'colorCode': c_hex,
                    'price': price,
                    'priceDelta': 0,
                    'inStock': in_stock,
                    'stock': 15 if in_stock else 0
                })

        return {
            'id': f"prod-eh-{id_num}",
            'name': name,
            'persianName': persian_name,
            'title': persian_name,
            'brand': brand,
            'category': category,
            'price': price,
            'stock': 20 if in_stock else 0,
            'inStock': in_stock,
            'active': True,
            'images': [img],
            'image': img,
            'slug': f"ehadish-{id_num}-{slug[:40]}".lower(),
            'source': 'puzzlekala',
            'sourceSupplier': 'ehadish',
            'supplierMatches': {
                'ehadish': {
                    'supplierProductId': id_num,
                    'category': cat,
                    'confirmedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
                }
            },
            'variants': [{'id': 'grp-colors', 'type': 'color', 'name': 'رنگ', 'options': colors}] if colors else [],
            'colors': colors if colors else None,
            'createdAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        }
    except Exception as e:
        print(f"Error fetching {cat}/{id_num}: {e}")
        return None

def main():
    print("1. Reading Ehadish sitemap...")
    req = urllib.request.Request("https://www.ehadish.com/sitemap.xml", headers=HEADERS)
    with urllib.request.urlopen(req) as resp:
        xml = resp.read().decode('utf-8')

    def get_candidates(cat_name, limit):
        pattern = r"<loc>https://www\.ehadish\.com/product/category-" + cat_name + r"/(\d+)-([^<]*)</loc>"
        matches = re.findall(pattern, xml)
        matches.sort(key=lambda x: int(x[0]), reverse=True)
        return [(cat_name, m[0], m[1]) for m in matches[:limit]]

    tasks = []
    tasks.extend(get_candidates("laptop", 35))
    tasks.extend(get_candidates("mobile", 35))
    tasks.extend(get_candidates("headphone", 20))
    tasks.extend(get_candidates("smart-watch", 15))
    tasks.extend(get_candidates("power-bank", 15))

    print(f"Total candidate products to fetch: {len(tasks)}")

    new_products = []
    with ThreadPoolExecutor(max_workers=12) as executor:
        futures = [executor.submit(fetch_product, t[0], t[1], t[2]) for t in tasks]
        for f in futures:
            p = f.result()
            if p:
                new_products.append(p)

    print(f"Successfully fetched {len(new_products)} products from Ehadish!")

    # Load existing products
    with open(PRODUCTS_FILE, 'r', encoding='utf-8') as f:
        existing_products = json.load(f)

    # Filter out any old ehadish products if any, keeping Kasra and HamrahTel
    kept_products = [p for p in existing_products if p.get('sourceSupplier') != 'ehadish' and not p.get('id', '').startswith('prod-eh-')]

    # Check for duplicate IDs
    existing_ids = {p['id'] for p in kept_products}
    added_count = 0
    for p in new_products:
        if p['id'] not in existing_ids:
            existing_ids.add(p['id'])
            kept_products.append(p)
            added_count += 1

    # Remove noSupplierRules and independent flags so prices follow supplier rules!
    for p in kept_products:
        p.pop('noSupplierRules', None)
        p.pop('independent', None)

    with open(PRODUCTS_FILE, 'w', encoding='utf-8') as f:
        json.dump(kept_products, f, ensure_ascii=False, indent=2)

    print(f"Total products in Puzzle Kala now: {len(kept_products)}")
    print(f"- Kasra Plus: {len([p for p in kept_products if p.get('sourceSupplier') == 'kasra'])}")
    print(f"- HamrahTel: {len([p for p in kept_products if p.get('sourceSupplier') == 'hamrahtel'])}")
    print(f"- Ehadish: {len([p for p in kept_products if p.get('sourceSupplier') == 'ehadish'])}")

    # Update suppliers.json to include Ehadish
    with open(SUPPLIERS_FILE, 'r', encoding='utf-8') as f:
        suppliers = json.load(f)

    ehadish_sup = next((s for s in suppliers if s['id'] == 'ehadish'), None)
    if not ehadish_sup:
        ehadish_sup = {
            'id': 'ehadish',
            'name': 'هدیش (Ehadish)',
            'enabled': True,
            'baseUrl': 'https://www.ehadish.com/',
            'connectionType': 'html_feed',
            'lastSyncAt': time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime()),
            'lastSuccessAt': time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime()),
            'lastError': None,
            'status': 'connected',
            'sourceTotalProducts': len(new_products),
            'sourceInStockProducts': len([p for p in new_products if p.get('inStock')]),
            'sourceOutOfStockProducts': len([p for p in new_products if not p.get('inStock')]),
            'matchedCount': len(new_products),
            'ambiguousCount': 0,
            'variantsCount': sum(len(p.get('variants', [])) for p in new_products),
            'inStockColorsCount': sum(len(p.get('colors') or []) for p in new_products)
        }
        suppliers.append(ehadish_sup)
    else:
        ehadish_sup['enabled'] = True
        ehadish_sup['status'] = 'connected'
        ehadish_sup['sourceTotalProducts'] = len(new_products)
        ehadish_sup['sourceInStockProducts'] = len([p for p in new_products if p.get('inStock')])
        ehadish_sup['sourceOutOfStockProducts'] = len([p for p in new_products if not p.get('inStock')])
        ehadish_sup['matchedCount'] = len(new_products)

    with open(SUPPLIERS_FILE, 'w', encoding='utf-8') as f:
        json.dump(suppliers, f, ensure_ascii=False, indent=2)

    print("Updated suppliers.json with Ehadish!")

if __name__ == '__main__':
    main()
