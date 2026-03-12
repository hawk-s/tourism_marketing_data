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
    const target = buttons.find(
      (btn) => btn.innerText && btn.innerText.trim().includes("See all reviews")
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

async function switchToNewest(page) {
  await page.waitForSelector("#sortBy_1", { timeout: 30000 });

  await page.click("#sortBy_1");
  await sleep(1000);

  //await page.focus("#sortBy_1");
  //await sleep(300);

  await page.keyboard.press("ArrowDown");
  await sleep(1000);

  await page.keyboard.press("ArrowDown");
  await sleep(1000);

  await page.keyboard.press("Enter");
  await sleep(2500);

  const isNewest = await page.evaluate(() => {
    const newestButton = document.querySelector('#sortBy_2[aria-label="Newest"]');
    if (newestButton) return true;

    const selected = Array.from(document.querySelectorAll('[role="button"]')).find((el) => {
      const label = el.getAttribute("aria-label") || "";
      const text = (el.innerText || "").trim();
      return label.includes("Newest") || text.includes("Newest");
    });

    return !!selected;
  });

  if (!isNewest) {
    throw new Error('Sort did not switch to "Newest".');
  }
}

async function scrollReviewsModal(page, maxScrolls = 40, delay = 700) {
  await page.waitForSelector("div.RHo1pe", { timeout: 30000 });

  let previousCount = 0;
  let noGrowthRounds = 0;

  for (let i = 0; i < maxScrolls; i++) {
    const result = await page.evaluate(() => {
      const reviewBlocks = document.querySelectorAll("div.RHo1pe");
      const currentCount = reviewBlocks.length;

      const firstReview = reviewBlocks[0];
      if (!firstReview) {
        return { currentCount, didScroll: false };
      }

      let parent = firstReview.parentElement;
      while (parent) {
        const style = window.getComputedStyle(parent);
        const isScrollable =
          (style.overflowY === "auto" || style.overflowY === "scroll") &&
          parent.scrollHeight > parent.clientHeight;

        if (isScrollable) {
          parent.scrollBy(0, 2500);
          return { currentCount, didScroll: true };
        }

        parent = parent.parentElement;
      }

      return { currentCount, didScroll: false };
    });

    if (!result.didScroll) {
      console.log("Could not find a scrollable reviews container.");
      break;
    }

    await sleep(delay);

    const newCount = await page.evaluate(
      () => document.querySelectorAll("div.RHo1pe").length
    );

    console.log(`Scroll ${i + 1}: ${newCount} reviews loaded`);

    if (newCount <= previousCount) {
      noGrowthRounds += 1;
    } else {
      noGrowthRounds = 0;
    }

    previousCount = newCount;

    if (noGrowthRounds >= 1100) {
      console.log("No new reviews loaded after several scrolls, stopping early.");
      break;
    }
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

    await sleep(3000);

    await clickSeeAllReviews(page);
    console.log('Clicked "See all reviews"');

    await sleep(2500);

    await switchToNewest(page);
    console.log('Switched sorting to "Newest"');

    await scrollReviewsModal(page, 1000, 700);
    console.log("Finished scrolling reviews modal");

    const html = await page.content();
    fs.writeFileSync("pokemon_go_page_raw7.html", html, "utf8");
    console.log("Saved raw HTML");

    const reviews = await page.evaluate(() => {
      function extractStars(label) {
        if (!label) return null;
        const m = label.match(/Rated\s+(\d+)/i);
        return m ? Number(m[1]) : null;
      }

      function extractHelpfulCount(block) {
        const helpfulContainer = block.querySelector(
          'div[jscontroller="SWD8cc"][data-original-thumbs-up-count]'
        );

        if (!helpfulContainer) return 0;

        const raw = helpfulContainer.getAttribute("data-original-thumbs-up-count");
        const parsed = Number(raw);

        return Number.isNaN(parsed) ? 0 : parsed;
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

        const helpful_count = extractHelpfulCount(block);

        results.push({
          review_id,
          nickname,
          stars,
          date,
          review_text,
          helpful_count
        });
      });

      return results;
    });

    fs.writeFileSync(
      "pokemon_go_reviews7.json",
      JSON.stringify(reviews, null, 2),
      "utf8"
    );

    console.log(`Extracted ${reviews.length} reviews`);
  } catch (error) {
    console.error("Scraping failed:", error);
  } finally {
    await browser.close();
  }
}

main();