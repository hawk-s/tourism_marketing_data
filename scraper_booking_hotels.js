const fs = require("fs");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

puppeteer.use(StealthPlugin());

// ─── Configuration ─────────────────────────────────────────────────────────────
const LINKS_FILE      = "booking_hotel_links.json";
const HOTELS_OUTPUT   = "booking_hotels_data.json";
const REVIEWS_OUTPUT  = "booking_reviews_data.json";

const SAVE_EVERY_N_HOTELS   = 5;      // write to disk after every N hotels
const MAX_REVIEW_PAGES      = 10;     // cap per hotel: 50 pages × 10 = 500 reviews
const DELAY_BETWEEN_HOTELS  = 3500;   // ms between hotel navigations
const PAGE_LOAD_WAIT        = 4500;   // ms after goto() settles
const REVIEW_PAGE_WAIT      = 2000;   // ms after clicking "Next page" in reviews
// ───────────────────────────────────────────────────────────────────────────────

let shutdownRequested  = false;
let shutdownSignalCount = 0;

// Module-level accumulators — populated by main() so the signal handler can
// flush them even on a forced second Ctrl+C.
let _hotels  = [];
let _reviews = [];

function requestGracefulShutdown(signalName) {
  shutdownSignalCount++;
  if (shutdownSignalCount === 1) {
    shutdownRequested = true;
    console.log(`\nReceived ${signalName}. Finishing current hotel then stopping...`);
    return;
  }
  // Second interrupt: save whatever we have before dying
  console.log("Second interrupt – saving data and exiting immediately.");
  try { saveData(_hotels, _reviews); } catch (e) { /* ignore */ }
  process.exit(130);
}

process.on("SIGINT",  () => requestGracefulShutdown("SIGINT"));
process.on("SIGTERM", () => requestGracefulShutdown("SIGTERM"));

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── State ─────────────────────────────────────────────────────────────────────
function loadExistingData() {
  let hotels   = [];
  let reviews  = [];
  const processed = new Set();

  if (fs.existsSync(HOTELS_OUTPUT)) {
    try {
      hotels = JSON.parse(fs.readFileSync(HOTELS_OUTPUT, "utf8"));
      for (const h of hotels) if (h.url) processed.add(h.url);
      console.log(`Resume: ${hotels.length} hotels already in ${HOTELS_OUTPUT}`);
    } catch (e) {
      console.warn(`Warning – could not parse ${HOTELS_OUTPUT}: ${e.message}`);
    }
  }

  if (fs.existsSync(REVIEWS_OUTPUT)) {
    try {
      reviews = JSON.parse(fs.readFileSync(REVIEWS_OUTPUT, "utf8"));
      console.log(`Resume: ${reviews.length} reviews already in ${REVIEWS_OUTPUT}`);
    } catch (e) {
      console.warn(`Warning – could not parse ${REVIEWS_OUTPUT}: ${e.message}`);
    }
  }

  return { hotels, reviews, processed };
}

function saveData(hotels, reviews) {
  fs.writeFileSync(HOTELS_OUTPUT,  JSON.stringify(hotels,  null, 2), "utf8");
  fs.writeFileSync(REVIEWS_OUTPUT, JSON.stringify(reviews, null, 2), "utf8");
  console.log(`  >> Saved ${hotels.length} hotels, ${reviews.length} reviews`);
}

// ─── Popup dismissal ───────────────────────────────────────────────────────────
async function dismissPopups(page) {
  // OneTrust cookie consent – Booking.com's provider
  try {
    const cookieBtn = await page.$("#onetrust-accept-btn-handler");
    if (cookieBtn) {
      await cookieBtn.click();
      await sleep(1200);
    }
  } catch (e) {}

  // Sign-in overlay / app download prompt / modal
  const dismissSelectors = [
    '[aria-label="Dismiss sign in information."]',
    '[data-testid="header-sign-in-prompt-close"]',
    '[data-testid="modal-close-button"]',
    'button[aria-label="Close"]',
    ".bui-modal__close",
  ];
  for (const sel of dismissSelectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        const visible = await page.evaluate(el => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        }, el);
        if (visible) { await el.click(); await sleep(600); }
      }
    } catch (e) {}
  }
}

// ─── Expand hotel description ("Show more" / "Read more" button) ─────────────
async function expandDescription(page) {
  const clicked = await page.evaluate(() => {
    // Booking.com uses several patterns for the description expander — try all
    const candidates = [
      // data-testid variants (newer layout)
      document.querySelector('[data-testid="property-description-show-more"]'),
      document.querySelector('[data-testid="property-description-toggle"]'),
      // aria-expanded=false on anything whose id/aria-controls contains "desc"
      ...Array.from(document.querySelectorAll(
        '[aria-expanded="false"][aria-controls*="description"],' +
        '[aria-expanded="false"][aria-controls*="desc"]'
      )),
      // Buttons / links inside known description containers whose text says "more"
      ...Array.from(document.querySelectorAll(
        '#property_description_content button,' +
        '#property_description_content a,' +
        '.hotel_description_wrapper button,' +
        '.k2-hp--description button,' +
        '.hp_desc_main_content button,' +
        '.hp-description button'
      )).filter(el => {
        const t = (el.innerText || el.textContent || "").trim().toLowerCase();
        return t.includes("show me more") || t.includes("show more") ||
               t.includes("read more") || t.includes("show full") ||
               t.includes("see more");
      }),
    ].filter(Boolean);

    if (!candidates.length) return false;
    candidates[0].click();
    return true;
  });

  if (clicked) await new Promise(r => setTimeout(r, 1000));
}

// ─── Hotel metadata extraction ─────────────────────────────────────────────────
async function extractHotelData(page, entry) {
  return await page.evaluate((entry) => {
    // window.utag_data is reliably populated on all Booking.com hotel pages
    const utag = window.utag_data || {};

    function safeText(el) {
      return el ? (el.innerText || el.textContent || "").trim() || null : null;
    }

    function trySelect(...selectors) {
      for (const sel of selectors) {
        try {
          const el = document.querySelector(sel);
          const t = safeText(el);
          if (t) return t;
        } catch (e) {}
      }
      return null;
    }

    function trySelectAll(...selectors) {
      for (const sel of selectors) {
        try {
          const els = document.querySelectorAll(sel);
          if (els.length) return Array.from(els).map(safeText).filter(Boolean);
        } catch (e) {}
      }
      return [];
    }

    // ── Name ────────────────────────────────────────────────────────────────────
    const name = utag.hotel_name ||
      trySelect(
        "h2#hp_hotel_name", "#hp_hotel_name", ".pp-header__title",
        'h1[data-testid="PropertyHeaderName"]', ".hotel-name-title"
      ) || entry.name;

    // ── Location ────────────────────────────────────────────────────────────────
    const city      = utag.city_name    || trySelect(".hp_address_subtitle", '[data-testid="PropertyHeaderAddress"]') || null;
    const region    = utag.region_name  || null;
    const country   = utag.country_name || null;
    const dest_name = utag.dest_name    || null; // e.g. "Albufeira, Algarve, Portugal"

    // ── IDs ─────────────────────────────────────────────────────────────────────
    const hotel_id      = utag.hotel_id || null;
    const property_type = utag.atnm_en  || utag.atnm || trySelect(".bui-breadcrumb__item:first-child", "[itemprop='@type']") || null;

    // ── Star rating ─────────────────────────────────────────────────────────────
    let star_rating = null;
    // aria-label "X out of 5" on the star container
    try {
      const ratingEl = document.querySelector(
        '[data-testid="rating-stars"][aria-label], .bui-rating[aria-label], span[aria-label*="out of 5"]'
      );
      if (ratingEl) {
        const m = (ratingEl.getAttribute("aria-label") || "").match(/^(\d)/);
        if (m) star_rating = Number(m[1]);
      }
    } catch (e) {}
    // Fallback: count filled star elements
    if (!star_rating) {
      const c = document.querySelectorAll(
        ".bui-rating__item, [data-testid='rating-stars'] .fc70cba028:not(.e2cec97860)"
      ).length;
      if (c) star_rating = c;
    }

    // ── Overall score ────────────────────────────────────────────────────────────
    let overall_score = utag.utrs ? Number(utag.utrs) : null;
    if (!overall_score) {
      const t = trySelect(
        ".review-score-badge", ".bui-review-score__badge",
        '[data-testid="review-score-badge"]', ".cb2cbb3ccb"
      );
      if (t) overall_score = Number(t.replace(",", ".")) || null;
    }

    const score_label = trySelect(
      ".review-score-widget__descriptor", ".bui-review-score__title",
      '[data-testid="review-score-label"]', ".review-score-widget-title"
    );

    // ── Review count ─────────────────────────────────────────────────────────────
    const rev_text = trySelect(
      ".reviews_stagger_effect_score_count", ".bui-review-score__text",
      '[data-testid="review-score-count"]', ".review-score-widget__subtext"
    );
    const num_reviews = rev_text ? parseInt(rev_text.replace(/[^0-9]/g, ""), 10) || null : null;

    // ── Subscores ────────────────────────────────────────────────────────────────
    const subscores = {};

    // Classic design (.c-score-bar rows)
    document.querySelectorAll(".c-score-bar, .review_score_breakdown_row").forEach(row => {
      const labelEl = row.querySelector(
        ".c-score-bar__label, .review_score_breakdown_criteria_name, .review-subscores-label"
      );
      const scoreEl = row.querySelector(
        ".c-score-bar__score, .review_score_breakdown_score, .review-subscores-score"
      );
      if (labelEl && scoreEl) {
        const key = safeText(labelEl);
        const val = Number((safeText(scoreEl) || "").replace(",", "."));
        if (key && !isNaN(val) && val > 0) subscores[key] = val;
      }
    });

    // Newer design: [data-testid*="subscore"]
    if (!Object.keys(subscores).length) {
      document.querySelectorAll('[data-testid*="subscore"], .review_score_breakdown_all_container > div').forEach(el => {
        const text = safeText(el) || "";
        const m    = text.match(/^([A-Za-z\s]+?)\s+([\d.,]+)$/);
        if (m) {
          const val = Number(m[2].replace(",", "."));
          if (!isNaN(val) && val > 0) subscores[m[1].trim()] = val;
        }
      });
    }

    // ── Hotel description ────────────────────────────────────────────────────────
    // The <p> itself carries data-testid="property-description" — it is NOT a child.
    // Collect all such <p> elements plus any <p> in the classic description containers.
    const descTexts = [];
    const descSelectors = [
      'p[data-testid="property-description"]',          // current Booking.com layout
      '#property_description_content p',                // classic layout
      '.hp_desc_main_content p',                        // older layout
      '.hotel-description p',
      '.k2-hp--description p',
    ];
    for (const sel of descSelectors) {
      try {
        const paras = Array.from(document.querySelectorAll(sel))
          .map(el => (el.innerText || el.textContent || "").trim())
          .filter(t => t.length > 5);
        if (paras.length) { descTexts.push(...paras); break; }
      } catch (e) {}
    }
    const description = descTexts.join("\n\n") || null;

    // ── Property highlights (sidebar box with section headers + items) ────────────
    // e.g. "Perfect for a 1-night stay!", "Top Location: ...", "Breakfast Info: ..."
    const highlights = [];
    try {
      document.querySelectorAll(".property-highlights .ph-section").forEach(section => {
        const header = (section.querySelector("h4.ph-item-header")?.innerText || "").trim();
        const items  = Array.from(section.querySelectorAll(".ph-item-copy span"))
          .map(el => (el.innerText || el.textContent || "").trim())
          .filter(t => t.length > 1);
        if (header)         highlights.push(header);
        highlights.push(...items);
      });
    } catch (e) {}
    // Fallback: newer data-testid pattern
    if (!highlights.length) {
      trySelectAll(
        '[data-testid="property-highlight"]',
        ".hp-highlights-text",
        ".highlight-label"
      ).forEach(t => highlights.push(t));
    }

    // ── Facilities – grouped by category (current #hp_facilities_box layout) ────
    // Produces facilities_grouped: { "Spa": { note, items:[{name, additional_charge}] }, ... }
    // and facilities: flat deduplicated array of names (for quick lookups).
    const facilities_grouped = {};
    const facilitySet = new Set();
    try {
      // Most popular facilities widget (flat, no grouping)
      document.querySelectorAll(
        '[data-testid="property-most-popular-facilities-wrapper"] .f6b6d2a959'
      ).forEach(el => {
        const t = safeText(el);
        if (t && t.length > 1) facilitySet.add(t);
      });

      // Full categorized groups – each [data-testid="facility-group-container"]
      document.querySelectorAll('[data-testid="facility-group-container"]').forEach(group => {
        // Category name lives in the first h3's .d31c9df771 div
        const firstH3   = group.querySelector("h3");
        const catNameEl = firstH3 ? firstH3.querySelector(".d31c9df771") : null;
        const category  = catNameEl
          ? (catNameEl.innerText || catNameEl.textContent || "").trim()
          : (firstH3 ? (firstH3.innerText || firstH3.textContent || "").trim() : "Other");
        if (!category) return;

        // Group-level note (e.g. "Wifi is available in all areas and is free of charge.")
        const noteEl = firstH3
          ? firstH3.querySelector(".b99b6ef58f.fb14de7f14.fdf31a9fa1")
          : null;
        const note = noteEl ? (noteEl.innerText || noteEl.textContent || "").trim() : null;

        const items = [];
        group.querySelectorAll("li").forEach(li => {
          const nameEl   = li.querySelector(".f6b6d2a959");
          const name     = nameEl ? (nameEl.innerText || nameEl.textContent || "").trim() : null;
          if (!name || name.length < 2) return;
          const chargeEl = li.querySelector(".f323fd7e96");
          const chargeText = chargeEl ? (chargeEl.innerText || chargeEl.textContent || "").trim().toLowerCase() : "";
          const additional_charge = chargeText.includes("additional charge") || chargeText.includes("charge");
          items.push({ name, additional_charge });
          facilitySet.add(name);
        });

        // Merge into facilities_grouped (same category can appear multiple times via sub-groups)
        if (!facilities_grouped[category]) {
          facilities_grouped[category] = { note: note || null, items };
        } else {
          // Append items; keep first non-null note
          facilities_grouped[category].items.push(...items);
          if (!facilities_grouped[category].note && note) facilities_grouped[category].note = note;
        }
      });
    } catch (e) {}

    // Fallback for older/non-standard layouts
    if (!Object.keys(facilities_grouped).length) {
      [
        '[data-testid="facility-list-item-name"]',
        '[data-testid="facility-list-item"] span',
        ".facilitiesChecklistSection li",
        ".bui-list__item .bui-list__body",
        ".hp_desc_facilities_block li",
        ".hp_popular_facilities li",
      ].forEach(sel => {
        try {
          document.querySelectorAll(sel).forEach(el => {
            const t = safeText(el);
            if (t && t.length > 1 && t.length < 120) facilitySet.add(t);
          });
        } catch (e) {}
      });
    }

    const facilities = [...facilitySet];

    // ── Coordinates ──────────────────────────────────────────────────────────────
    let lat = null, lng = null;
    try {
      const html = document.body.innerHTML;
      const latM = html.match(/"latitude"\s*:\s*([\d.+-]+)/);
      const lngM = html.match(/"longitude"\s*:\s*([\d.+-]+)/);
      if (latM) lat = Number(latM[1]);
      if (lngM) lng = Number(lngM[1]);
    } catch (e) {}

    // ── Awards / certificates / sustainability ───────────────────────────────────
    const awards = trySelectAll(
      ".hp-awards__content", '[data-testid="sustainability-certificate"]',
      ".sustainability-award-text", ".hp_certificate_award"
    );

    // ── Hotel area info (POI distances by category) ───────────────────────────────
    // Produces e.g. { "Beaches in the Neighborhood": [{name, type, distance_m}], ... }
    // Useful for computing per-category median/min distances as location variables.
    const area_info = {};
    try {
      function parseDistanceToMeters(distText) {
        const t = (distText || "").trim().toLowerCase();
        const mMatch = t.match(/^([\.\d]+)\s*m$/);
        if (mMatch) return Math.round(Number(mMatch[1]));
        const kmMatch = t.match(/^([\.\d]+)\s*km$/);
        if (kmMatch) return Math.round(Number(kmMatch[1]) * 1000);
        return null;
      }
      document.querySelectorAll('[data-testid="poi-block"]').forEach(block => {
        const h3 = block.querySelector("h3");
        const category = h3 ? (h3.innerText || h3.textContent || "").trim() : "Other";
        if (!category) return;
        const items = [];
        block.querySelectorAll('[data-testid="poi-block-list"] li').forEach(li => {
          // Name container holds an optional sub-type span + the name text node
          const nameEl  = li.querySelector(".aa225776f2.ca9d921c46.d1bc97eb82");
          const typeEl  = nameEl ? nameEl.querySelector(".f0595bb7c6") : null;
          const typeText = typeEl ? (typeEl.innerText || typeEl.textContent || "").trim() : null;
          let nameText   = nameEl ? (nameEl.innerText || nameEl.textContent || "").trim() : "";
          // Strip the sub-type prefix so we get a clean name
          if (typeText && nameText.startsWith(typeText)) nameText = nameText.slice(typeText.length).trim();
          const distEl    = li.querySelector(".b99b6ef58f.fb14de7f14.cbf0753d0c");
          const distText  = distEl ? (distEl.innerText || distEl.textContent || "").trim() : null;
          const distance_m = parseDistanceToMeters(distText);
          if (nameText) items.push({ name: nameText, type: typeText || null, distance_m });
        });
        if (items.length) area_info[category] = items;
      });
    } catch (e) {}

    return {
      url:           entry.url,
      hotel_id,
      name,
      city,
      region,
      country,
      dest_name,
      star_rating,
      property_type,
      overall_score,
      score_label,
      num_reviews,
      subscores,
      description,
      highlights,
      facilities,
      facilities_grouped,
      awards,
      area_info,
      lat,
      lng,
      scraped_at: new Date().toISOString(),
    };
  }, entry);
}

// ─── Reviews ───────────────────────────────────────────────────────────────────
async function navigateToReviews(page) {
  // Current Booking.com layout (2025+): clicking "Read all reviews" navigates
  // to a new reviewlist.html page. We must wait for full navigation.
  const clickSelectors = [
    // Current layout buttons (confirmed from real HTML)
    '[data-testid="fr-read-all-reviews"]',
    '[data-testid="review-score-read-all-actionable"]',
    '[data-testid="read-all-actionable"]',
    '[data-testid="reviews-block-availability"]',
    // Legacy selectors
    '[data-testid="see-all-reviews-button"]',
    ".show_all_reviews_link",
    "#show_user_reviews",
    'a[class*="all_reviews"]',
  ];

  for (const sel of clickSelectors) {
    try {
      const el = await page.$(sel);
      if (!el) continue;
      // Click and wait for navigation (reviewlist.html is a new page load)
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 12000 }).catch(() => {}),
        el.click(),
      ]);
      await sleep(2000);
      const hasBlocks = await page.evaluate(() =>
        document.querySelectorAll(
          [
            '[data-testid="review-card"]',
            ".review_list_new_item",
            ".c-review-block",
            '[data-testid="review-container"]',
            "[data-review-id]",
          ].join(", ")
        ).length > 0
      );
      if (hasBlocks) return;
    } catch (e) {}
  }

  // Fallback: directly build the reviewlist URL from current hotel URL
  try {
    const currentUrl = page.url();
    const slugMatch  = currentUrl.match(/\/hotel\/pt\/([^./?]+)/);
    if (slugMatch) {
      const reviewUrl = `https://www.booking.com/reviewlist.html?pagename=${slugMatch[1]}&lang=en-us`;
      await page.goto(reviewUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
      await sleep(2000);
    }
  } catch (e) {}
}

// Expand any truncated review texts on the current page
async function expandReviewTexts(page) {
  await page.evaluate(() => {
    document.querySelectorAll('[data-testid="review-pr-toggle"]').forEach(btn => {
      const t = (btn.innerText || btn.textContent || "").trim();
      if (t.toLowerCase().includes("continue")) btn.click();
    });
  });
  await sleep(600);
}

async function extractReviewsOnPage(page, hotelUrl) {
  return await page.evaluate((hotelUrl) => {
    const reviews = [];

    function safeText(el) {
      return el ? (el.innerText || el.textContent || "").trim() || null : null;
    }

    function findText(root, ...selectors) {
      for (const sel of selectors) {
        try {
          const el = root.querySelector(sel);
          const t  = safeText(el);
          if (t) return t;
        } catch (e) {}
      }
      return null;
    }

    // Find review blocks (try selectors in order of specificity)
    const blockSelectors = [
      '[data-testid="review-card"]',        // current reviewlist.html layout
      ".review_list_new_item",
      ".c-review-block",
      ".bui-review-item",
      '[data-testid="review-container"]',
      "[data-review-id]",
      ".user-review__content",
    ];

    let blocks = [];
    for (const sel of blockSelectors) {
      const found = Array.from(document.querySelectorAll(sel));
      if (found.length) { blocks = found; break; }
    }

    blocks.forEach(block => {
      // review_id
      const review_id =
        block.getAttribute("data-review-id") ||
        block.querySelector("[data-review-id]")?.getAttribute("data-review-id") ||
        null;

      // Name + country: most reliably extracted from the VOTE_HELPFUL aria-label
      let reviewer_name    = null;
      let reviewer_country = null;
      const voteBtn = block.querySelector('[data-testid="VOTE_HELPFUL"], [aria-label*="Mark the review by"]');
      if (voteBtn) {
        const m = (voteBtn.getAttribute("aria-label") || "")
          .match(/Mark the review by (.+?) from (.+?) as helpful/i);
        if (m) { reviewer_name = m[1].trim(); reviewer_country = m[2].trim(); }
      }

      // DOM fallbacks
      if (!reviewer_name) {
        reviewer_name = findText(block,
          ".bui-avatar-block__title", ".reviewer_name",
          ".c-review-block__name", '[data-testid="review-author-name"]'
        );
      }
      if (!reviewer_country) {
        const raw = findText(block,
          ".bui-avatar-block__subtitle", ".reviewer_country",
          ".c-review-block__country", '[data-testid="review-author-country"]'
        );
        // Strip leading flag characters/whitespace that can appear in DOM text
        if (raw) reviewer_country = raw.replace(/^[^\w]+/, "").trim();
      }

      // Date
      const date = findText(block,
        ".c-review-block__date", ".bui-review-item__date",
        '[data-testid="review-date"]', ".review_item_date",
        ".review-panel-wide__date", "span.c_review_date"
      );

      // Individual review score
      const score_text = findText(block,
        ".bui-review-score__badge", ".review-score-badge",
        '[data-testid="review-score"]', ".c-review-block__score"
      );
      const score = score_text ? Number(score_text.replace(",", ".")) || null : null;

      // Positive part (what reviewer liked)
      const positive_text = findText(block,
        ".review_pos p", ".bui-review-item__content .review_pos",
        '[data-testid="review-positive"]', ".c-review__body--positive",
        ".c-review-block__body--positive p", ".review_pos"
      );

      // Negative part (what reviewer disliked)
      const negative_text = findText(block,
        ".review_neg p", ".bui-review-item__content .review_neg",
        '[data-testid="review-negative"]', ".c-review__body--negative",
        ".c-review-block__body--negative p", ".review_neg"
      );

      // Combined review text for newer layouts with no pos/neg split
      let review_text = null;
      if (!positive_text && !negative_text) {
        review_text = findText(block,
          ".c-review__body", ".bui-review-item__body",
          '[data-testid="review-body"]', ".review-text p"
        );
      }

      // Travel purpose / guest type
      const traveller_type = findText(block,
        ".review-panel-wide__traveller_type .bui-list__body",
        ".c-review-block__traveller-type",
        '[data-testid="review-traveller-type"]',
        ".bui-list__item--travel-type .bui-list__body"
      );

      // Room type stayed
      const room_info = findText(block,
        ".review-panel-wide__room_info_top .bui-list__body",
        ".c-review-block__room-type",
        '[data-testid="review-room-type"]',
        ".bui-list__item--room-type .bui-list__body",
        ".room_type"
      );

      // Nights stayed
      const nights_raw = findText(block,
        ".review-panel-wide__stay_date_top .bui-list__body",
        ".c-review-block__nights",
        '[data-testid="review-nights"]',
        ".bui-list__item--nights .bui-list__body",
        ".stay_date"
      );
      const nightsMatch = nights_raw ? nights_raw.match(/(\d+)\s*night/i) : null;
      const nights_stayed = nightsMatch ? Number(nightsMatch[1]) : null;

      // Helpful count
      const helpfulEl = block.querySelector("[data-original-thumbs-up-count]");
      const helpful_count = helpfulEl
        ? Number(helpfulEl.getAttribute("data-original-thumbs-up-count")) || 0
        : 0;

      reviews.push({
        hotel_url:       hotelUrl,
        review_id,
        reviewer_name,
        reviewer_country,
        date,
        score,
        positive_text,
        negative_text,
        review_text,
        traveller_type,
        room_info,
        nights_stayed,
        helpful_count,
      });
    });

    return reviews;
  }, hotelUrl);
}

async function extractAllReviews(page, hotelUrl) {
  const allReviews = [];
  const seenKeys   = new Set();

  await navigateToReviews(page);

  for (let pageNum = 1; pageNum <= MAX_REVIEW_PAGES; pageNum++) {
    if (shutdownRequested) break;

    // Expand any "Continue reading" toggles before extracting
    await expandReviewTexts(page);

    const pageReviews = await extractReviewsOnPage(page, hotelUrl);

    if (!pageReviews.length) {
      if (pageNum === 1) console.log("  No reviews found on this page.");
      break;
    }

    let added = 0;
    for (const rev of pageReviews) {
      // Deduplicate: prefer review_id, fall back to composite key
      const key = rev.review_id || `${rev.reviewer_name}|${rev.date}|${rev.score}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        allReviews.push(rev);
        added++;
      }
    }

    if (added === 0) {
      console.log(`  Page ${pageNum}: no new reviews – likely end of list, stopping.`);
      break;
    }

    console.log(`  Reviews page ${pageNum}: +${added} (total: ${allReviews.length})`);

    // Check for an active (non-disabled) "Next page" button scoped to reviews
    const hasNext = await page.evaluate(() => {
      // Prefer a next-page button inside a known reviews container
      const containers = [
        document.querySelector("#reviews_wrapper"),
        document.querySelector("#review_list_page_container"),
        document.querySelector('[data-testid="reviews-section"]'),
        document,
      ];
      const nextSelectors = [
        'button[aria-label="Next page"]:not([disabled])',
        '[data-testid="pagination-next"]:not([disabled])',
        'a[aria-label="Next page"]:not([aria-disabled="true"])',
      ];
      for (const root of containers) {
        if (!root) continue;
        for (const sel of nextSelectors) {
          if (root.querySelector(sel)) return true;
        }
      }
      return false;
    });

    if (!hasNext) {
      console.log("  No more review pages.");
      break;
    }

    // Click the next-page button, scoped to reviews when possible
    try {
      await page.evaluate(() => {
        const containers = [
          document.querySelector("#reviews_wrapper"),
          document.querySelector("#review_list_page_container"),
          document.querySelector('[data-testid="reviews-section"]'),
          document,
        ];
        const nextSelectors = [
          'button[aria-label="Next page"]:not([disabled])',
          '[data-testid="pagination-next"]:not([disabled])',
          'a[aria-label="Next page"]:not([aria-disabled="true"])',
        ];
        for (const root of containers) {
          if (!root) continue;
          for (const sel of nextSelectors) {
            const btn = root.querySelector(sel);
            if (btn) { btn.click(); return; }
          }
        }
      });
      await sleep(REVIEW_PAGE_WAIT);
    } catch (err) {
      console.log(`  Could not advance to next review page: ${err.message}`);
      break;
    }
  }

  return allReviews;
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const links = JSON.parse(fs.readFileSync(LINKS_FILE, "utf8"));
  console.log(`Loaded ${links.length} hotel links from ${LINKS_FILE}`);

  const { hotels: _h, reviews: _r, processed } = loadExistingData();
  // Sync into module-level accumulators so the signal handler can flush them
  _hotels  = _h;
  _reviews = _r;
  const hotels  = _hotels;
  const reviews = _reviews;

  const pending = links.filter(l => l.url && !processed.has(l.url));
  console.log(`Pending: ${pending.length} hotels\n`);

  if (!pending.length) {
    console.log("All hotels already processed.");
    return;
  }

  const browser = await puppeteer.launch({
    headless: false,
    handleSIGINT:  false,
    handleSIGTERM: false,
    args: ["--lang=en-US,en", "--no-sandbox"],
  });

  let sessionCount = 0;

  try {
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

    for (const entry of pending) {
      if (shutdownRequested) {
        console.log("\nShutdown requested. Stopping loop.");
        break;
      }

      console.log(`\n[${sessionCount + 1}/${pending.length}] ${entry.name || entry.url}`);

      try {
        // Append lang parameter for consistent English output
        const url = entry.url.includes("?")
          ? `${entry.url}&lang=en-us`
          : `${entry.url}?lang=en-us`;

        await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
        await sleep(PAGE_LOAD_WAIT);

        await dismissPopups(page);
        await expandDescription(page);

        // ── Hotel-level data ─────────────────────────────────────────────────────
        const hotelData = await extractHotelData(page, entry);
        console.log(
          `  Name: ${hotelData.name} | Stars: ${hotelData.star_rating ?? "?"} ` +
          `| Score: ${hotelData.overall_score ?? "?"} | Reviews: ${hotelData.num_reviews ?? "?"}`
        );

        // ── Reviews ──────────────────────────────────────────────────────────────
        const hotelReviews = await extractAllReviews(page, entry.url);
        console.log(`  Collected ${hotelReviews.length} reviews`);

        hotels.push(hotelData);
        reviews.push(...hotelReviews);
        sessionCount++;

        if (sessionCount % SAVE_EVERY_N_HOTELS === 0) {
          saveData(hotels, reviews);
        }

      } catch (err) {
        console.error(`  ERROR: ${err.message}`);
        // Record the failed hotel so it is skipped on the next resume
        hotels.push({
          url:        entry.url,
          name:       entry.name || null,
          error:      err.message,
          scraped_at: new Date().toISOString(),
        });
        sessionCount++;
      }

      if (!shutdownRequested) await sleep(DELAY_BETWEEN_HOTELS);
    }

  } catch (err) {
    console.error("Fatal error:", err);
  } finally {
    saveData(hotels, reviews);
    await browser.close();
    console.log(
      `\nSession complete. Hotels this session: ${sessionCount}` +
      ` | Total hotels: ${hotels.length} | Total reviews: ${reviews.length}`
    );
  }
}

main();
