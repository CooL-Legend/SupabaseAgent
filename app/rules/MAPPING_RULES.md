# Column Mapping Rules

## Priority Order for Matching
1. **Exact name match** (case-insensitive) → confidence 0.95+
2. **Normalized match** (underscores, hyphens, spaces removed) → confidence 0.90
3. **Abbreviation match** (e.g., "fname" → "first_name", "qty" → "quantity") → confidence 0.85
4. **Semantic match** (e.g., "cell" → "phone_number", "DOB" → "date_of_birth") → confidence 0.70-0.85
5. **Data-shape match** (values look like emails but column name differs) → confidence 0.60-0.70

## Type Inference Rules
- If DB type is `integer`/`bigint`/`smallint` and CSV values are numeric strings → `to_integer`
- If DB type is `numeric`/`real`/`double precision` and CSV values are decimal strings → `to_number`
- If DB type is `boolean` and CSV values match true/false/yes/no/1/0 → `to_boolean`
- If DB type is `timestamp`/`timestamptz` → detect format (ISO-8601, Unix epoch, US date, EU date) → `to_timestamp`
- If DB type is `date` → `to_date`
- If DB type is `uuid` and CSV values match UUID pattern → `to_uuid`
- If DB type is `jsonb`/`json` → `to_json`
- If DB type is `ARRAY` → `to_array`
- If CSV has currency symbols ($, €, £) and DB is numeric → strip symbols + `to_number`
- If CSV has thousand separators (1,000) and DB is numeric → strip commas + `to_number`

## Hidden Type Detection
- **Unix epochs**: Large integers (10+ digits) mapping to timestamp columns
- **Comma-separated numbers**: "1,234.56" → need comma stripping before cast
- **Padded IDs**: "007" → if DB is text keep as-is, if numeric strip leading zeros
- **Phone numbers**: "+1-555-123-4567" → may need normalization
- **Boolean variants**: "Y"/"N", "Active"/"Inactive", "1"/"0"
- **Null variants**: "N/A", "null", "None", "-", "" → all map to SQL NULL

## Risk Flags (must report)
- CSV column with >20% null rate mapping to NOT NULL DB column
- CSV column with duplicate values mapping to UNIQUE DB column
- CSV string values exceeding DB character_maximum_length
- DB column with foreign key constraint not validated against CSV data
- Any mapping with confidence < 0.70 must be flagged for human review

## Forbidden Actions
- NEVER map one CSV column to multiple DB columns
- NEVER invent data that doesn't exist in the CSV
- NEVER silently drop required columns — always flag as critical
