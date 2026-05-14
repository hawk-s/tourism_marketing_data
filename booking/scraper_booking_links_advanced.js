const fs   = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

puppeteer.use(StealthPlugin());

const SEARCH_URL =
  "https://www.booking.com/searchresults.html?region=1064&order=class";
// Use __dirname so the output file lands next to this script, not in cwd.
const OUTPUT_FILE = path.join(__dirname, "booking_hotel_links.json");
const SAVE_EVERY_N_LINKS = 25;

let shutdownRequested = false;
let shutdownSignalCount = 0;

// Keyed by base URL to deduplicate across rounds without re-scanning old entries
const hotelMap = new Map();

function requestGracefulShutdown(signalName) {
  shutdownSignalCount += 1;

  if (shutdownSignalCount === 1) {
    shutdownRequested = true;
    console.log(
      `Received ${signalName}. Stopping scroll and saving collected data...`
    );
    return;
  }

  console.log("Second interrupt received. Exiting immediately.");
  process.exit(130);
}

process.on("SIGINT", () => requestGracefulShutdown("SIGINT"));
process.on("SIGTERM", () => requestGracefulShutdown("SIGTERM"));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function saveData() {
  const hotels = Array.from(hotelMap.values());
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(hotels, null, 2), "utf8");
  console.log(`Saved ${hotels.length} hotel entries to ${OUTPUT_FILE}`);
}

async function switchToGrid(page) {
  await page.waitForSelector('input[name="view"]', { timeout: 30000 });

  const isAlreadyGrid = await page.evaluate(() => {
    const gridInput = document.querySelector('input[name="view"][value="grid"]');
    return gridInput ? gridInput.checked : false;
  });

  if (isAlreadyGrid) {
    console.log("Grid view already active.");
    return;
  }

  await page.evaluate(() => {
    const gridInput = document.querySelector('input[name="view"][value="grid"]');
    if (!gridInput) return;

    // Prefer clicking the label (visible element) to trigger the radio properly
    const label = document.querySelector(`label[for="${gridInput.id}"]`);
    if (label) {
      label.click();
    } else {
      gridInput.click();
    }
  });

  await sleep(2000);

  const confirmed = await page.evaluate(() => {
    const gridInput = document.querySelector('input[name="view"][value="grid"]');
    return gridInput ? gridInput.checked : false;
  });

  if (!confirmed) {
    throw new Error('Could not switch to grid view.');
  }

  console.log("Switched to grid view.");
}

async function extractHotels(page) {
  return await page.evaluate(() => {
    const hotels = [];

    document.querySelectorAll('[data-testid="property-card"]').forEach((card) => {
      const titleLink = card.querySelector('[data-testid="title-link"]');
      if (!titleLink) return;

      const href = titleLink.getAttribute("href") || "";
      if (!href.includes("/hotel/")) return;

      // Strip tracking params — keep only the clean hotel path
      const qIndex = href.indexOf("?");
      const baseUrl = qIndex !== -1 ? href.substring(0, qIndex) : href;
      if (!baseUrl) return;

      const name =
        card.querySelector('[data-testid="title"]')?.innerText.trim() || null;

      hotels.push({ name, url: baseUrl });
    });

    return hotels;
  });
}

async function scrollAndCollect(page, maxRounds = 5000, delay = 900) {
  let lastSaveSize = hotelMap.size;
  let noGrowthRounds = 0;

  for (let round = 0; round < maxRounds; round++) {
    if (shutdownRequested) {
      console.log("Graceful stop requested. Ending collection loop.");
      break;
    }

    // Harvest whatever is currently rendered
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
      console.log(`Round ${round + 1}: ${hotelMap.size} unique hotels (+${added})`);
    } else {
      noGrowthRounds++;
    }

    // Periodic save — flush to disk, Map stays in memory (entries are tiny)
    if (hotelMap.size - lastSaveSize >= SAVE_EVERY_N_LINKS) {
      saveData();
      lastSaveSize = hotelMap.size;
    }

    // Check for and click "Load more results" button before scrolling
    const loadMoreClicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const btn = buttons.find(
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
      console.log(
        `Round ${round + 1}: Clicked "Load more results", waiting for content...`
      );
      await sleep(2500);
      noGrowthRounds = 0;
    } else {
      // Scroll down to trigger lazy-loading
      await page.evaluate(() => window.scrollBy(0, 2000));
      await sleep(delay);
    }

    if (noGrowthRounds >= 7) {
      console.log(
        "No new hotels found after several rounds. Assuming end of results."
      );
      break;
    }
  }
}

async function main() {
  const browser = await puppeteer.launch({
    headless: false,
    handleSIGINT: false,
    handleSIGTERM: false,
  });

  try {
    const page = await browser.newPage();

    await page.goto(SEARCH_URL, { waitUntil: "networkidle2" });
    await sleep(3000);

    await switchToGrid(page);

    await scrollAndCollect(page, 5000, 900);
    console.log("Finished collecting hotel links.");

    if (shutdownRequested) {
      console.log("Saving partial data from currently collected hotels.");
    }

    saveData();
    console.log(`Total: ${hotelMap.size} unique hotels extracted.`);
  } catch (error) {
    console.error("Scraping failed:", error);
    if (hotelMap.size > 0) {
      saveData();
    }
  } finally {
    await browser.close();
  }
}

main();
