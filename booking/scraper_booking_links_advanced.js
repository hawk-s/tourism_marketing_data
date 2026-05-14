// Advanced hotel link scraper for Booking.com (Algarve region).
//
// STRATEGY
// ─────────────────────────────────────────────────────────────────────────────
// Booking.com caps infinite-scroll results at roughly 1 000 per search.
// To capture every hotel we break the search space into small enough slices:
//
//   1. Load any previously collected hotels from disk (resume-safe).
//   2. Visit the base Algarve search page and scrape all city/district
//      "uf=" filter codes from the sidebar.
//   3. For each star rating (5 → 1):
//      a. If result count < SPLIT_THRESHOLD  → scroll and collect directly.
//      b. If result count ≥ SPLIT_THRESHOLD AND city filters are available
//         → iterate star × city combinations (+ one catch-all pass).
//      c. If result count ≥ SPLIT_THRESHOLD AND no city filters found
//         → iterate the same star filter with several sort orders so that
//           different top-1000 slices are covered.
//   4. Save combined, deduplicated results.
//
// DEDUPLICATION
// ─────────────────────────────────────────────────────────────────────────────
// The global hotelMap is keyed by the clean hotel URL (query params stripped).
// It is pre-populated from the existing output file at startup, so the script
// can be stopped and resumed without losing work.

const fs   = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

puppeteer.use(StealthPlugin());

// ── Configuration ─────────────────────────────────────────────────────────────

const REGION_ID       = "1064";   // Algarve
const BASE_SEARCH_URL = `https://www.booking.com/searchresults.html?region=${REGION_ID}`;
const OUTPUT_FILE     = path.join(__dirname, "booking_hotel_links.json");

const SAVE_EVERY       = 25;    // Flush to disk every N new hotels
const SPLIT_THRESHOLD  = 850;   // Subdivide when a segment has >= this many results
const SCROLL_DELAY_MS  = 900;
const NO_GROWTH_LIMIT  = 7;     // Rounds with no new hotels before declaring exhausted

const STAR_RATINGS = [5, 4, 3, 2, 1];  // Processed high → low

// Sort orders used as fallback when no city filters are available and a
// star-rating bucket exceeds SPLIT_THRESHOLD.  Each ordering exposes a
// different top-1000 slice of results.
// Values are the data-id attributes from the sorters dropdown (= &order= param).
const FALLBACK_ORDERS = [
  "popularity",             // Our top picks (default ranking)
  "price_from_high_to_low", // Price highest first
  "class",                  // Property rating high to low
  "class_asc",              // Property rating low to high
  "score",                  // Top reviewed
];

// ── State ─────────────────────────────────────────────────────────────────────

let shutdownRequested   = false;
let shutdownSignalCount = 0;

// Keyed by clean base URL — populated from file at startup + updated during run
const hotelMap = new Map();

// ── Signal handling ───────────────────────────────────────────────────────────

function requestGracefulShutdown(signalName) {
  shutdownSignalCount += 1;
  if (shutdownSignalCount === 1) {
    shutdownRequested = true;
    console.log(`\nReceived ${signalName}. Finishing current round and saving...`);
    return;
  }
  console.log("Second interrupt — exiting immediately.");
  process.exit(130);
}

process.on("SIGINT",  () => requestGracefulShutdown("SIGINT"));
process.on("SIGTERM", () => requestGracefulShutdown("SIGTERM"));

// ── Utilities ─────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Navigate to url with automatic retries.  Uses "domcontentloaded" instead of
 * "networkidle2" so Booking.com cannot abort by withholding resource responses.
 * The caller is responsible for any post-navigation sleep.
 */
async function gotoWithRetry(page, url, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      return;
    } catch (err) {
      if (attempt === maxRetries) throw err;
      console.log(`  Navigation failed (attempt ${attempt}): ${err.message}`);
      console.log(`  Retrying in 8 s...`);
      await sleep(8000);
    }
  }
}

function saveData() {
  const hotels = Array.from(hotelMap.values());
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(hotels, null, 2), "utf8");
  console.log(`  Saved ${hotels.length} hotels → ${path.basename(OUTPUT_FILE)}`);
}

/**
 * Load previously collected hotels from OUTPUT_FILE into hotelMap so that
 * re-running the script never loses work and naturally deduplicates.
 */
function loadExistingData() {
  if (!fs.existsSync(OUTPUT_FILE)) {
    console.log("No existing data file — starting fresh.");
    return;
  }
  try {
    const data = JSON.parse(fs.readFileSync(OUTPUT_FILE, "utf8"));
    for (const hotel of data) {
      if (hotel.url) hotelMap.set(hotel.url, hotel);
    }
    console.log(`Loaded ${hotelMap.size} existing hotels from file.`);
  } catch (err) {
    console.warn("Could not load existing data:", err.message);
  }
}

/**
 * Build a search URL for the Algarve region with optional star-rating,
 * city (uf) and sort-order filters.
 */
function buildUrl({ stars = null, uf = null, order = null } = {}) {
  const nfltParts = [];
  if (stars !== null) nfltParts.push(`class=${stars}`);
  if (uf    !== null) nfltParts.push(`uf=${uf}`);
  let url = BASE_SEARCH_URL;
  if (nfltParts.length) url += `&nflt=${encodeURIComponent(nfltParts.join(";"))}`;
  if (order)            url += `&order=${order}`;
  return url;
}

// ── Page helpers ──────────────────────────────────────────────────────────────

async function switchToGrid(page) {
  try {
    await page.waitForSelector('input[name="view"]', { timeout: 10000 });

    const isAlreadyGrid = await page.evaluate(() => {
      const g = document.querySelector('input[name="view"][value="grid"]');
      return g ? g.checked : false;
    });
    if (isAlreadyGrid) return;

    await page.evaluate(() => {
      const g = document.querySelector('input[name="view"][value="grid"]');
      if (!g) return;
      const lbl = document.querySelector(`label[for="${g.id}"]`);
      (lbl || g).click();
    });

    await sleep(2000);
  } catch {
    // Grid toggle not present on this page variant — continue anyway
  }
}

/**
 * Read the "X properties found" result count shown in the page header.
 * Returns null when the element is not present or cannot be parsed.
 */
async function getResultCount(page) {
  try {
    return await page.evaluate(() => {
      const selectors = [
        'h1[aria-live="assertive"]',       // confirmed 2026: aria-label has the number
        '[data-testid="header-number-of-results"]',
        'h1[aria-live="polite"]',
        '[data-testid="searchresults-header"]',
        '[data-testid="header-container"] h1',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (!el) continue;
        // Prefer aria-label (e.g. "We found 17,392 places to stay for you…")
        const src = el.getAttribute("aria-label") || el.innerText || "";
        const m = src.replace(/[\s,.]/g, "").match(/\d{2,}/);
        if (m) return parseInt(m[0], 10);
      }
      // Broad fallback: any h1/h2 mentioning properties or results
      for (const el of document.querySelectorAll("h1, h2")) {
        const text = (el.innerText || "").toLowerCase();
        if (text.includes("propert") || text.includes("result")) {
          const m = (el.innerText || "").replace(/[\s,.]/g, "").match(/\d{2,}/);
          if (m) return parseInt(m[0], 10);
        }
      }
      return null;
    });
  } catch {
    return null;
  }
}

/**
 * Extract star-rating property counts from the sidebar on the currently
 * loaded search page.  Returns { 5: number, 4: number, 3: number, … }.
 * Uses the same sidebar present on the base Algarve page (Step 1).
 */
async function extractStarCounts(page) {
  return await page.evaluate(() => {
    const counts = {};
    document.querySelectorAll('[data-filters-group="class"] [data-filters-item]').forEach((el) => {
      const val = el.getAttribute("data-filters-item") || "";
      const m   = val.match(/class=(\d+)/);
      if (!m) return;
      const stars = parseInt(m[1], 10);

      // Try dedicated count element
      const countEl = el.querySelector('[data-testid="filters-group-label-count"]');
      if (countEl) {
        const n = (countEl.innerText || "").replace(/[\s,.]/g, "").match(/\d+/);
        if (n) { counts[stars] = parseInt(n[0], 10); return; }
      }
      // Try aria-label on the checkbox
      const inp = el.querySelector("input");
      if (inp) {
        const label = inp.getAttribute("aria-label") || "";
        const n = label.replace(/[\s,.]/g, "").match(/\d{3,}/);
        if (n) { counts[stars] = parseInt(n[0], 10); return; }
      }
      // Fallback: largest number (≥3 digits) in the item text
      const n = (el.innerText || "").replace(/[\s,.]/g, "").match(/\d{3,}/);
      if (n) counts[stars] = parseInt(n[0], 10);
    });
    return counts;
  });
}

/**
 * Extract city / district filter codes (uf=) from the sidebar on the
 * currently loaded search page.
 *
 * Confirmed DOM structure (Booking.com, 2026):
 *   <div data-filters-group="uf" …>
 *     <div data-filters-item="uf:uf=-2157420" …>
 *       <input name="uf=-2157420" value="uf=-2157420" …>
 *       <div data-testid="filters-group-label-content">Albufeira</div>
 *     </div>
 *     …
 *   </div>
 *
 * Returns [{ name: string, uf: string }]
 */
async function extractCityFilters(page) {
  return await page.evaluate(() => {
    const seen    = new Set();
    const filters = [];

    function add(uf, labelEl) {
      if (seen.has(uf)) return;
      seen.add(uf);
      const name =
        (labelEl?.innerText || labelEl?.textContent || "")
          .split("\n")[0]
          .trim() || `uf_${uf}`;
      filters.push({ name, uf });
    }

    // Strategy 1 (primary — confirmed selector):
    // Scope to data-filters-group="uf" and read the exact label element.
    document.querySelectorAll('[data-filters-group="uf"] [data-filters-item]').forEach((el) => {
      const val = el.getAttribute("data-filters-item") || "";
      const m   = val.match(/uf=(-?\d+)/);
      if (!m) return;
      const nameEl = el.querySelector('[data-testid="filters-group-label-content"]');
      add(m[1], nameEl || el);
    });

    // Strategy 2 (fallback): <a href> links containing uf= in nflt param.
    if (filters.length === 0) {
      document.querySelectorAll("a[href]").forEach((a) => {
        const href = a.getAttribute("href") || "";
        if (!href.includes("searchresults")) return;
        const m = href.match(/[?&]nflt=([^&]*)/);
        if (!m) return;
        const nflt = decodeURIComponent(m[1]);
        if (nflt.includes("class=")) return;
        const ufM = nflt.match(/(?:^|;)uf=(-?\d+)/);
        if (ufM) add(ufM[1], a);
      });
    }

    // Strategy 3 (fallback): any [data-filters-item] containing uf=NUMBER.
    if (filters.length === 0) {
      document.querySelectorAll("[data-filters-item]").forEach((el) => {
        const val = el.getAttribute("data-filters-item") || "";
        const m   = val.match(/uf=(-?\d+)/);
        if (m) add(m[1], el.querySelector('[data-testid="filters-group-label-content"]') || el);
      });
    }

    // Strategy 4 (fallback): checkboxes with name="uf=NUMBER" (confirmed attribute format).
    if (filters.length === 0) {
      document.querySelectorAll("input[type='checkbox']").forEach((inp) => {
        const m = (inp.getAttribute("name") || "").match(/^uf=(-?\d+)$/);
        if (!m) return;
        add(m[1], document.querySelector(`label[for="${inp.id}"]`));
      });
    }

    return filters;
  });
}

async function extractHotels(page) {
  return await page.evaluate(() => {
    const hotels = [];
    document.querySelectorAll('[data-testid="property-card"]').forEach((card) => {
      const titleLink = card.querySelector('[data-testid="title-link"]');
      if (!titleLink) return;

      const href = titleLink.getAttribute("href") || "";
      if (!href.includes("/hotel/")) return;

      const qIndex  = href.indexOf("?");
      const baseUrl = qIndex !== -1 ? href.substring(0, qIndex) : href;
      if (!baseUrl) return;

      const name =
        card.querySelector('[data-testid="title"]')?.innerText.trim() || null;

      hotels.push({ name, url: baseUrl });
    });
    return hotels;
  });
}

/**
 * Scroll / click "Load more results" on the current page until no new hotels
 * appear for NO_GROWTH_LIMIT consecutive rounds.
 */
async function scrollAndCollect(page, label) {
  let lastSaveSize   = hotelMap.size;
  let noGrowthRounds = 0;

  for (let round = 0; round < 5000; round++) {
    if (shutdownRequested) {
      console.log(`    [${label}] Graceful stop — ending collection.`);
      break;
    }

    const extracted = await extractHotels(page);
    let added = 0;
    for (const hotel of extracted) {
      if (!hotelMap.has(hotel.url)) {
        hotelMap.set(hotel.url, hotel);
        added++;
      }
    }

    if (added > 0) {
      noGrowthRounds = 0;
      console.log(`    [${label}] round ${round + 1}: total ${hotelMap.size} (+${added})`);
    } else {
      noGrowthRounds++;
    }

    if (hotelMap.size - lastSaveSize >= SAVE_EVERY) {
      saveData();
      lastSaveSize = hotelMap.size;
    }

    const loadMoreClicked = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find(
        (b) => (b.innerText || "").trim() === "Load more results"
      );
      if (btn) {
        btn.scrollIntoView({ behavior: "smooth", block: "center" });
        btn.click();
        return true;
      }
      return false;
    });

    if (loadMoreClicked) {
      console.log(`    [${label}] clicked "Load more results"`);
      await sleep(2500);
      noGrowthRounds = 0;
    } else {
      await page.evaluate(() => window.scrollBy(0, 2000));
      await sleep(SCROLL_DELAY_MS);
    }

    if (noGrowthRounds >= NO_GROWTH_LIMIT) {
      console.log(`    [${label}] exhausted (${hotelMap.size} total)`);
      break;
    }
  }
}

/**
 * Navigate to url, switch to grid view, then scroll-collect.
 */
async function navigateAndCollect(page, url, label) {
  if (shutdownRequested) return;
  console.log(`\n  [${label}]`);
  console.log(`  ${url}`);
  await gotoWithRetry(page, url);
  await sleep(3000);
  await switchToGrid(page);
  await scrollAndCollect(page, label);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  loadExistingData();

  const browser = await puppeteer.launch({
    headless: false,
    handleSIGINT:  false,
    handleSIGTERM: false,
  });

  try {
    const page = await browser.newPage();

    // ── Step 1: Extract city/district filter codes from the sidebar ──────────
    console.log("\n=== Extracting city filter codes ===");
    await gotoWithRetry(page, BASE_SEARCH_URL);
    await sleep(4000);

    // Expand the city (uf) filter group so all cities are visible in the DOM.
    // The button has data-testid="filters-group-expand-collapse" and text like
    // "Show all 25" — must be scoped to data-filters-group="uf" to avoid
    // accidentally expanding other filter sections.
    await page.evaluate(() => {
      const expandBtn = document.querySelector(
        '[data-filters-group="uf"] [data-testid="filters-group-expand-collapse"]'
      );
      if (expandBtn) expandBtn.click();
    });
    await sleep(1500);

    const cityFilters = await extractCityFilters(page);
    if (cityFilters.length > 0) {
      console.log(`Found ${cityFilters.length} city/district filters:`);
      cityFilters.forEach((f) => console.log(`  "${f.name}"  uf=${f.uf}`));
    } else {
      console.log("No city filters found — will use sort-order fallback if needed.");
    }

    const starCounts = await extractStarCounts(page);
    if (Object.keys(starCounts).length > 0) {
      console.log("Star counts from sidebar:");
      for (const [s, c] of Object.entries(starCounts).sort((a, b) => b[0] - a[0]))
        console.log(`  ${s}-star: ${c.toLocaleString()} properties`);
    } else {
      console.log("Could not read star counts from sidebar — will rely on page header.");
    }

    // ── Step 2: Iterate star ratings ─────────────────────────────────────────
    for (const stars of STAR_RATINGS) {
      if (shutdownRequested) break;

      const starLabel = `${stars}-star`;
      const starUrl   = buildUrl({ stars });

      console.log(`\n${"=".repeat(60)}`);
      console.log(`COLLECTING ${stars}-STAR HOTELS`);

      // Navigate to check the result count before choosing a strategy
      await gotoWithRetry(page, starUrl);
      await sleep(3000);

      let count = await getResultCount(page);
      if (count === null && starCounts[stars] !== undefined) {
        count = starCounts[stars];
        console.log(`Result count: ${count.toLocaleString()} (from sidebar cache)`);
      } else {
        console.log(`Result count: ${count !== null ? count.toLocaleString() : "unknown"}`);
      }

      const overLimit = count !== null && count >= SPLIT_THRESHOLD;

      if (overLimit && cityFilters.length > 0) {
        // ── Strategy A: city-level subdivision ────────────────────────────────
        // Note: 3-star has ~7 000 and 4-star ~7 800 properties in the Algarve,
        // so a single city can itself exceed SPLIT_THRESHOLD and needs a nested
        // sort-order pass.
        console.log(`Over threshold (${count}). Subdividing into ${cityFilters.length} cities...`);

        for (const city of cityFilters) {
          if (shutdownRequested) break;
          const cityUrl   = buildUrl({ stars, uf: city.uf });
          const cityLabel = `${starLabel} / ${city.name}`;

          await gotoWithRetry(page, cityUrl);
          await sleep(3000);
          const cityCount = await getResultCount(page);

          if (cityCount !== null && cityCount >= SPLIT_THRESHOLD) {
            // City still too large — apply all sort orders within this city
            console.log(`  "${city.name}" has ${cityCount} results — subdividing by sort order...`);
            for (const order of FALLBACK_ORDERS) {
              if (shutdownRequested) break;
              await navigateAndCollect(
                page,
                buildUrl({ stars, uf: city.uf, order }),
                `${cityLabel} / ${order}`
              );
            }
          } else {
            // Manageable count — scroll directly
            await switchToGrid(page);
            await scrollAndCollect(page, cityLabel);
          }
        }

        // Catch-all pass: hotels in rural areas not covered by any city filter
        console.log(`\n  Catch-all pass (${starLabel}, no city filter)...`);
        await navigateAndCollect(page, starUrl, `${starLabel} catch-all`);

      } else if (overLimit && cityFilters.length === 0) {
        // ── Strategy B: sort-order subdivision ────────────────────────────────
        console.log(`Over threshold but no city filters. Using ${FALLBACK_ORDERS.length} sort orders...`);

        for (const order of FALLBACK_ORDERS) {
          if (shutdownRequested) break;
          await navigateAndCollect(
            page,
            buildUrl({ stars, order }),
            `${starLabel} / order:${order}`
          );
        }

      } else {
        // ── Strategy C: direct collection ─────────────────────────────────────
        await switchToGrid(page);
        await scrollAndCollect(page, starLabel);
      }

      saveData();
    }

    console.log(`\n${"=".repeat(60)}`);
    console.log("Collection complete.");
    saveData();
    console.log(`Total unique hotels: ${hotelMap.size}`);

  } catch (err) {
    console.error("Fatal error:", err);
    if (hotelMap.size > 0) saveData();
  } finally {
    await browser.close();
  }
}

main();
