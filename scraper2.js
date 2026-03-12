const fs = require("fs");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

puppeteer.use(StealthPlugin());

const URL =
  "https://play.google.com/store/apps/details?id=com.nianticlabs.pokemongo&hl=en&gl=us";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function clickSeeAllReviews(page) {
  await page.waitForSelector("button", { timeout: 30000 });

  const clicked = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll("button"));
    const target = buttons.find((btn) =>
      btn.innerText && btn.innerText.trim().includes("See all reviews")
    );

    if (target) {
      target.click();
      return true;
    }

    return false;
  });

  if (!clicked) {
    throw new Error('Could not find the "See all reviews" button.');
  }
}

async function scrollReviewsModal(page, maxScrolls = 20, delay = 1500) {
  await page.waitForSelector("div.RHo1pe", { timeout: 30000 });

  for (let i = 0; i < maxScrolls; i++) {
    const didScroll = await page.evaluate(() => {
      const reviewBlock = document.querySelector("div.RHo1pe");
      if (!reviewBlock) return false;

      // Find the nearest scrollable parent of a review block
      let parent = reviewBlock.parentElement;
      while (parent) {
        const style = window.getComputedStyle(parent);
        const isScrollable =
          (style.overflowY === "auto" || style.overflowY === "scroll") &&
          parent.scrollHeight > parent.clientHeight;

        if (isScrollable) {
          parent.scrollBy(0, 1200);
          return true;
        }

        parent = parent.parentElement;
      }

      return false;
    });

    if (!didScroll) {
      console.log("Could not find a scrollable reviews container.");
      break;
    }

    await sleep(delay);
  }
}

async function main() {
  const browser = await puppeteer.launch({
    headless: false
  });

  try {
    const page = await browser.newPage();

    await page.goto(URL, {
      waitUntil: "networkidle2"
    });

    await sleep(4000);

    // Click "See all reviews"
    await clickSeeAllReviews(page);
    console.log('Clicked "See all reviews"');

    await sleep(3000);

    // Scroll inside the reviews modal
    await scrollReviewsModal(page, 25, 1500);
    console.log("Finished scrolling reviews modal");

    // Save raw HTML after modal content has loaded
    const html = await page.content();
    fs.writeFileSync("pokemon_go_page_raw.html", html, "utf8");
    console.log("Saved raw HTML");

    // Extract reviews directly from DOM
    const reviews = await page.evaluate(() => {
      function extractStars(label) {
        if (!label) return null;
        const m = label.match(/Rated\s+(\d+)/i);
        return m ? Number(m[1]) : null;
      }

      const reviewBlocks = document.querySelectorAll("div.RHo1pe");
      const results = [];

      reviewBlocks.forEach((block) => {
        const header = block.querySelector("header.c1bOId");
        const review_id = header?.getAttribute("data-review-id") || null;

        const nickname =
          block.querySelector("div.X5PpBb")?.innerText.trim() || null;

        const date =
          block.querySelector("span.bp9Aid")?.innerText.trim() || null;

        const ratingLabel =
          block
            .querySelector('div[role="img"][aria-label*="Rated"]')
            ?.getAttribute("aria-label") || null;

        const stars = extractStars(ratingLabel);

        const review_text =
          block.querySelector("div.h3YV2d")?.innerText.trim() || null;

        results.push({
          review_id,
          nickname,
          stars,
          date,
          review_text
        });
      });

      return results;
    });

    fs.writeFileSync(
      "pokemon_go_reviews.json",
      JSON.stringify(reviews, null, 2),
      "utf8"
    );

    console.log(`Extracted ${reviews.length} reviews`);
  } catch (error) {
    console.error("Scraping failed:", error);
  } finally {
    // keep browser open if you want to inspect manually:
    // comment this out if needed
    // await browser.close();
  }
}

main();