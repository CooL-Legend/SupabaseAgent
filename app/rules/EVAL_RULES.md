# Evaluation Rules & Scoring

## Score Components (weights sum to 1.0)

| Component           | Weight | Description                                               |
|---------------------|--------|-----------------------------------------------------------|
| Type Compatibility  | 0.30   | Can CSV values actually be cast to DB column types?       |
| Null Coverage       | 0.20   | Are NOT NULL columns covered by non-null CSV columns?     |
| Unique Compliance   | 0.15   | Will UNIQUE constraints be satisfied?                     |
| Required Coverage   | 0.25   | Are all mandatory columns (NOT NULL, no default) mapped?  |
| Confidence Average  | 0.10   | Average confidence across all mappings.                   |

## Thresholds

- **Pass**: score >= 0.80
- **Needs Review**: 0.50 <= score < 0.80
- **Fail**: score < 0.50

## Type Compatibility Checks

For each mapped column, take up to 20 sample values and attempt the transformation:
- Success rate >= 95% → score 1.0
- Success rate >= 80% → score 0.7
- Success rate >= 50% → score 0.3
- Success rate < 50% → score 0.0

## Issue Severity Classification

### Critical (blocks ingestion)
- NOT NULL column without default has no CSV mapping
- Primary key column has no CSV mapping
- Type cast failure rate > 50% on a required column
- UNIQUE constraint violation detected in CSV data

### Warning (proceed with caution)
- Type cast failure rate 5-50%
- Confidence < 0.70 on any mapping
- CSV column null rate > 20% mapping to NOT NULL (with default)
- String truncation needed (CSV values exceed max_length)

### Info (acceptable)
- Optional DB columns with no CSV mapping (nullable + has default)
- Extra CSV columns being dropped
- Exact name matches (confidence >= 0.95)

## Reflection Triggers

If evaluation fails, the reflection must:
1. List every issue sorted by severity
2. For each issue, explain WHY the mapper got it wrong
3. Suggest a specific prompt adjustment for the next turn
4. Track which issues are recurring vs. new
