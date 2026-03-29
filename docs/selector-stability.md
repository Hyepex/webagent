# Google Flights Selector Stability Report

Verified: 2026-03-29 | Playwright 1.58.2 | Headed Chromium

## Extraction Strategy

**Primary**: Parse `div[role="link"][aria-label*="flight with"]` — each element's
`aria-label` contains ALL flight data in a single structured sentence:

```
"From 4039 Indian rupees. Nonstop flight with IndiGo.
 Leaves Chhatrapati Shivaji Maharaj International Airport Mumbai at 1:55 PM on Monday, June 1
 and arrives at Goa Dabolim International Airport at 3:25 PM on Monday, June 1.
 Total duration 1 hr 30 min. Select flight"
```

**Fallback**: Per-field aria-label spans inside `li` cards.

## Card Container

| Selector | Count | Risk | Notes |
|----------|-------|------|-------|
| `div[role="link"][aria-label*="flight with"]` | Matches all priced flights | **LOW** | ARIA role + label. Google uses these for screen readers. Unlikely to change without breaking a11y compliance. |
| `li:has([aria-label*="rupees"])` | 20 (includes duplicates) | LOW | Structural `li` + ARIA child. Requires dedup. |
| `li.pIav2d` | 20 | **HIGH** | Minified class name. Will break on next CSS rebuild. |

**Chosen**: `div[role="link"][aria-label*="flight with"]` — dedup by airline+departure in JS.

## Field Extraction from aria-label (Primary)

All parsed via regex from the `aria-label` string. No sub-selectors needed.

| Field | Regex | Risk | Notes |
|-------|-------|------|-------|
| Price | `/(\d[\d,]*)\s*Indian rupees/i` | **LOW** | Standard Google a11y price format. Filters out "price is unavailable". |
| Airline | `/flight with\s+(.+?)\.\s/i` | **LOW** | Sentence structure: "flight with {airline}." |
| Departure | `/at\s+(\d{1,2}:\d{2}\s*(?:AM\|PM))\s+on/gi` (1st match) | **LOW** | "at 1:55 PM on Monday" — standard time format. |
| Arrival | Same regex (2nd match) | **LOW** | Same pattern, second occurrence. |
| Duration | `/Total duration\s+(.+?)\.?\s*(?:Select\|$)/i` | **LOW** | "Total duration 1 hr 30 min." |
| Stops | `/nonstop/i` or `/(\d+)\s*stop/i` | **LOW** | "Nonstop flight" vs "1 stop flight". |

## Fallback Field Selectors (inside each `li` card)

Used only when primary strategy returns 0 results.

| Field | Selector | Risk | Text | Notes |
|-------|----------|------|------|-------|
| Price | `span[role="text"][aria-label*="rupees"]` | **LOW** | `₹4,039` | ARIA role + label. Multiple per card (3x); use `.first()`. |
| Departure | `[aria-label^="Departure time"]` | **LOW** | `1:55 PM` | Stable ARIA label prefix. |
| Arrival | `[aria-label^="Arrival time"]` | **LOW** | `3:25 PM` | Stable ARIA label prefix. |
| Duration | `[aria-label^="Total duration"]` | **LOW** | `1 hr 30 min` | Stable ARIA label prefix. |
| Stops | `[aria-label*="Nonstop"]` | **LOW** | `Nonstop` | Or `[aria-label*="stop flight"]` for connecting flights. |
| Airline | Text match against known airline list | **MEDIUM** | `IndiGo` | No aria-label on airline span. Depends on airline name list staying current. |

## Data Attributes Found (informational)

These exist in the DOM but are NOT used for extraction:

| Attribute | Location | Example | Notes |
|-----------|----------|---------|-------|
| `data-ved` | `div` wrapper | Opaque token | Google tracking, changes per request |
| `data-id` | `div` wrapper | `if5Hcd` | Internal flight ID, not stable |
| `data-co2currentflight` | Emissions `div` | `43000` | CO2 in grams |
| `data-travelimpactmodelwebsiteurl` | Emissions `div` | URL with itinerary | Contains route+airline+date |
| `data-gs` | Price `span` | Base64 blob | Encoded flight/price data |

## Verification Results

### Phase 3: Same route, 5 consecutive runs
- Route: Mumbai (BOM) → Goa (GOI), 2026-06-01
- **5/5 passed**: 5 flights each, all fields populated, identical structure

### Phase 4: Different routes
| Route | Flights | All fields? | Notes |
|-------|---------|-------------|-------|
| Mumbai → Delhi | 5 | Yes | Domestic, Akasa Air + IndiGo |
| Bangalore → Chennai | 5 | Yes | Short-haul, duration "55 min" handled |
| Delhi → Dubai | 5 | Yes | International, 1-stop flights, multi-airline ("Air India and Air India Express") |

### Phase 5: Full pipeline (npm test)
- 4/4 recipes passed
- Flight recipe: 18s, found cheapest at ₹3,724

## When to Update

Check these selectors if:
1. Google Flights redesigns their results page
2. The recipe starts returning 0 flights
3. Google changes their ARIA labeling scheme (unlikely — WAI-ARIA compliance)

Debug: Save `page.content()` and `page.locator('body').ariaSnapshot()` on failure to compare DOM vs expected structure.
