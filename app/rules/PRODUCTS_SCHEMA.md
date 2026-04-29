# Products Table — Complete Reference

## Table: `products` (19,294 rows)

This is a fashion e-commerce product catalog. All products are from Bewakoof brand (Indian fashion retailer). The table stores product metadata, pricing, images, and a 512-dimension embedding vector for recommendations.

## Column Reference

### `id` — UUID, PRIMARY KEY, NOT NULL, DEFAULT uuid_generate_v4()
- Auto-generated UUIDv4. 19,294 unique values.
- CSV column names that map here: "id", "product_id", "productId", "sku_id", "item_id", "uuid"
- If CSV has sequential integers (1, 2, 3...) they are NOT UUIDs — either generate UUIDs or skip this column (let DB auto-generate).
- If CSV has UUIDs, validate format: `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`

### `title` — VARCHAR(255), NOT NULL
- **NEW SEMANTICS (post-2026-04 migration):** `title` now holds the **product line / family name** only — the leading title-cased or UPPERCASE tokens of the full product name, BEFORE any gender/garment descriptor.
- Examples (good):
  - `"Nike ACG 'Lava Loft'"` (line name)
  - `"GRAPHICS TRAIN CONCEPT"` (PUMA line)
  - `"VELOCITY"` (PUMA line)
- Examples (BAD — these are descriptors, belong in `SUBTITLE` instead):
  - `"Men's Therma-FIT Jacket"`
  - `"Women's Training Tee"`
- CSV names that may contain this field directly: `title`, `name`, `product_name`, `productName`, `item_name`, `product_title`, `line_name`, `product_line`.

**SPLIT RULE (critical for PUMA/Nike/Adidas-style CSVs):** when the only available CSV column is a single combined `product_name` like `"GRAPHICS TRAIN CONCEPT Women's Training Tee"`, emit TWO mapping entries:
1. `product_name → title` — transform: take the substring BEFORE the first gender/garment descriptor token, then `.trim()`. Descriptor tokens to split on (case-insensitive, in this priority order): `Men's`, `Women's`, `Unisex`, `Kids'`, `Boys'`, `Girls'`, `Baby`. If none of these tokens are found, return the full trimmed `product_name` (the whole thing IS the line name).
2. `product_name → SUBTITLE` — see SUBTITLE section below.

If the CSV provides distinct `title`/`subtitle` (or `line_name`/`description`) columns natively, prefer those over the split.

- VALIDATION: Truncate to 255 chars if longer. Strip leading/trailing whitespace.

### `SUBTITLE` — TEXT, NULLABLE
- **Case-sensitive column name** — the column was created as `"SUBTITLE"` (quoted, uppercase) in Postgres. Always emit the `dbColumn` as exactly `SUBTITLE` (uppercase). Do NOT lowercase it.
- Holds the **descriptor tail** of the product name: gender + garment type + variant info.
- Examples:
  - `"Men's Therma-FIT Jacket"`
  - `"Women's Training Tee"`
  - `"Women's 3\" Running Shorts"`
- CSV names that may contain this directly: `subtitle`, `description` (when short), `product_description`, `garment_description`, `style_description`.

**SPLIT RULE:** for combined `product_name` CSVs (see `title` above), emit a second mapping entry:
- `product_name → SUBTITLE` — transform: find the FIRST occurrence of a gender/garment descriptor token (`Men's | Women's | Unisex | Kids' | Boys' | Girls' | Baby`, case-insensitive) and return the substring STARTING at that token, then `.trim()`. If no token is found, return `null`.

Example transform body:
```js
const v = value?.trim(); if (!v) return null;
const m = v.match(/\b(Men's|Women's|Unisex|Kids'|Boys'|Girls'|Baby)\b/i);
return m ? v.slice(m.index).trim() : null;
```

For the `title` half, the corresponding transform body is:
```js
const v = value?.trim(); if (!v) return null;
const m = v.match(/\b(Men's|Women's|Unisex|Kids'|Boys'|Girls'|Baby)\b/i);
return m ? v.slice(0, m.index).trim() : v;
```

### `price` — NUMERIC(10,2), NOT NULL
- Price in Indian Rupees (INR). Range: ₹39 to ₹3,169. Average: ₹603.
- Distribution: 57% under ₹500, 32% ₹500-1000, 11% ₹1000-2000, 0.2% over ₹2000
- CSV names: "price", "mrp", "cost", "retail_price", "selling_price", "amount", "rate"
- CRITICAL TRANSFORMS:
  - Strip currency symbols: "$", "₹", "Rs", "Rs.", "INR", "EUR", "€", "£"
  - Strip thousand separators: "1,299.00" → "1299.00"
  - Handle "1299" (no decimal) → "1299.00"
  - Reject negative prices or zero prices (flag for review)
  - If price > 50,000, likely wrong currency or data error — flag it

### `brand` — VARCHAR(100), NULLABLE
- The brand TOKEN ONLY — no garment description, no product line. Examples: `"PUMA"`, `"Nike"`, `"Bewakoof®"`, `"Adidas"`.
- Historic data: most rows are `"Bewakoof®"` (19,293 rows) or `"Bewakoof"` (1 row). New imports add `"PUMA"`, `"Nike"`, etc.
- CSV names: "brand", "brand_name", "manufacturer", "vendor", "seller"
- DO NOT put the product line name here (that goes in `title`). DO NOT put the descriptor here (that goes in `SUBTITLE`).
- Note the ® symbol in "Bewakoof®" — CSV data may have plain "Bewakoof" which is fine.
- Max 100 chars.

### `image_url` — TEXT, NULLABLE
- Primary product image URL. 0% null. Always Bewakoof CDN URLs.
- Pattern: `https://images.bewakoof.com/original/...jpg`
- CSV names: "image_url", "imageUrl", "image", "thumbnail", "img_url", "main_image", "photo_url", "picture_url", "primary_image"
- VALIDATION: Must start with http:// or https://. Must be a valid URL.

### `created_at` — TIMESTAMPTZ, NULLABLE, DEFAULT now()
- Auto-set to current time. Let DB handle this — skip from CSV unless explicitly provided.
- CSV names: "created_at", "createdAt", "created_date", "date_added", "added_on"

### `product_embedding` — VECTOR(512), NULLABLE, DEFAULT zeros
- 512-dimensional float vector for ML similarity search. Default is all zeros.
- NEVER import from CSV. This is computed by ML pipeline. Always skip/ignore.
- If CSV has a column called "embedding", "vector", "product_embedding" → SKIP IT.

### `category` — TEXT, NULLABLE
- Broad product category. 17 distinct values. 0% null.
- Top values: Topwear (83%), Bottomwear (11%), Footwear (3%), Combo (1%)
- Full list: Topwear, Bottomwear, Footwear, Combo, Innerwear & Sleepwear, set, Mask, Socks, Nightwear, Protective Mask, Bags & Backpacks, Shirt, Accessories, Mobile Covers, Beauty & Grooming, Swimwear, Sports & Active Wear
- CSV names: "category", "product_category", "main_category", "department", "type", "section"
- VALIDATION: Match to existing values (case-insensitive). "topwear" → "Topwear", "t-shirts" → "Topwear"
- SEMANTIC MAP: "Shirts" → Topwear, "Pants"/"Jeans" → Bottomwear, "Shoes"/"Sandals" → Footwear

### `product_type` — TEXT, NULLABLE
- Specific garment type. 76 distinct values. 0% null.
- Top: T-Shirt (59%), Sweatshirt (6%), Hoodies (5%), Vest (4%), Joggers (3%), Sliders (3%), Shirt (2%), Pyjama (2%), Jacket (2%)
- CSV names: "product_type", "type", "sub_category", "subcategory", "item_type", "garment_type", "clothing_type"
- IMPORTANT: If CSV has "type" column, check if values look like product types or categories.

### `color` — TEXT, NULLABLE, 3.4% null
- Color with internal code number. 2,033 distinct values.
- Format: "Color Name NumberCode" like "Black 01", "Blue 128", "RED 13", "AOP 100"
- Some are complex: "Aloe Wash 01-Blue 128" (multi-color)
- CSV names: "color", "colour", "color_name", "shade", "variant_color"
- If CSV just has "Black" or "Red" without the number suffix, that's fine — map as-is.

### `available_sizes` — TEXT, NULLABLE, 75.7% null (mostly empty!)
- Comma-separated size list. Only 24.3% of products have this filled.
- Format: "S, M, L, XL, 2XL, 3XL" or single size "6XL"
- CSV names: "available_sizes", "sizes_available", "size_options", "size_list", "size_range"
- Note: This column is DIFFERENT from `sizes` column below.

### `gender` — TEXT, NULLABLE, 0% null
- Target gender. 4 values: Men (61%), Women (39%), Unisex (0.2%), "men" (1 row — lowercase inconsistency)
- CSV names: "gender", "sex", "target_gender", "for", "gender_target", "audience"
- VALIDATION: Normalize case → "Men", "Women", "Unisex". Map: "Male"/"M"/"Boy" → "Men", "Female"/"F"/"Girl" → "Women", "Unisex"/"All"/"Both" → "Unisex"

### `product_url` — TEXT, NULLABLE, 0% null
- Full product page URL on Bewakoof.
- Pattern: `https://www.bewakoof.com/p/...`
- CSV names: "product_url", "url", "link", "product_link", "page_url", "item_url"

### `color_hex` — TEXT, NULLABLE, 3.4% null
- Hex color code(s). Can be single "#9D202F" or multi "#d3e16f,#191919"
- CSV names: "color_hex", "hex_color", "color_code", "hex", "rgb"
- VALIDATION: Must match pattern `#[0-9a-fA-F]{6}` (can be comma-separated for multi).

### `all_image_urls` — TEXT, NULLABLE, 0% null
- Pipe-separated list of all product image URLs.
- Separator: " | " (space-pipe-space)
- Typically 3-7 images per product.
- CSV names: "all_image_urls", "images", "image_urls", "gallery", "all_images", "additional_images"
- If CSV uses comma or semicolon separator, convert to " | "

### `sizes` — TEXT, NULLABLE, DEFAULT '', 100% empty
- Currently completely empty for all rows. Default is empty string ''.
- This column exists but is unused. CSV data can map here if needed.
- CSV names: "sizes", "size"

## Columns that CSV ingest MUST SKIP (HARD RULE)

These columns are populated by separate backend pipelines, NOT by CSV ingest. Do NOT include them in `columnMappings` under any circumstance. If the CSV happens to contain a column with one of these names (or a close variant), list the CSV column under `unmappedCsvColumns` with the reason `"Owned by separate pipeline — do not ingest from CSV"`.

- `gcs_front_url` — populated by the GCS image upload API (front shot)
- `gcs_back_url` — populated by the GCS image upload API (back shot)
- `garment_features` — populated by the feature-extraction service
- `product_embedding` — populated by the ML embedding pipeline
- `created_at` — DB default `now()`; let the DB set it

## Common CSV Scenarios for This Table

### Scenario 1: E-commerce product feed (Shopify, WooCommerce, etc.)
Expected columns: name/title, price, brand, category, image, url, color, size, gender
Challenges: Price may have "$" or "₹", sizes may be in different format, categories won't match exactly.

### Scenario 2: Scraped product data
Expected columns: product_name, mrp, brand_name, img_url, product_url, color, type
Challenges: URLs might be relative, prices might be strings, duplicates likely.

### Scenario 3: Supplier/wholesale CSV
Expected columns: SKU, Product Name, Unit Price, Brand, Category, Sizes
Challenges: SKU is not UUID, price might be wholesale (different from retail), categories are vendor-specific.

### Scenario 4: Inventory/catalog CSV
Expected columns: ID, Name, Price, Color, Size, Stock, Image
Challenges: ID might be integer not UUID, Size might be single value not list, Stock column has no DB match.

## Critical Business Rules
1. `id` + `title` + `price` are the minimum viable product record.
2. If no UUID provided, let the database generate one (skip `id` in mapping).
3. `product_embedding` should ALWAYS be skipped — it's ML-computed.
4. `sizes` and `gcs_front_url` and `gcs_back_url` are currently unused — low priority.
5. `gender` MUST be normalized to "Men"/"Women"/"Unisex".
6. `price` MUST be a positive number ≤ 50,000 (anything higher is likely an error).
7. `all_image_urls` uses " | " as separator, not commas.
