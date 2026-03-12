import re
import json
import requests
from bs4 import BeautifulSoup


URL = "https://play.google.com/store/apps/details?id=com.nianticlabs.pokemongo&hl=en&gl=us"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/123.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9"
}


def extract_stars(review_block):
    rating_div = review_block.select_one('div[role="img"][aria-label*="Rated"]')
    if not rating_div:
        return None

    aria_label = rating_div.get("aria-label", "")
    match = re.search(r"Rated\s+(\d+)\s+stars?", aria_label)

    return int(match.group(1)) if match else None


def parse_reviews(html):
    soup = BeautifulSoup(html, "html.parser")

    reviews = []

    for review_block in soup.select("div.RHo1pe"):

        header = review_block.select_one("header.c1bOId")
        review_id = header.get("data-review-id") if header else None

        nickname_el = review_block.select_one("div.X5PpBb")
        nickname = nickname_el.get_text(strip=True) if nickname_el else None

        date_el = review_block.select_one("span.bp9Aid")
        review_date = date_el.get_text(strip=True) if date_el else None

        stars = extract_stars(review_block)

        review_text_el = review_block.select_one("div.h3YV2d")
        review_text = review_text_el.get_text(" ", strip=True) if review_text_el else None

        reviews.append({
            "review_id": review_id,
            "nickname": nickname,
            "stars": stars,
            "date": review_date,
            "review_text": review_text
        })

    return reviews


def main():

    print("Downloading page...")

    response = requests.get(URL, headers=HEADERS, timeout=30)
    response.raise_for_status()

    html = response.text

    # Save raw HTML
    with open("pokemon_go_page_raw.html", "w", encoding="utf-8") as f:
        f.write(html)

    print("Raw HTML saved as pokemon_go_page_raw.html")

    # Parse reviews
    reviews = parse_reviews(html)

    print(f"Extracted {len(reviews)} reviews")

    # Save parsed reviews
    with open("pokemon_go_reviews.json", "w", encoding="utf-8") as f:
        json.dump(reviews, f, indent=2, ensure_ascii=False)

    print("Reviews saved to pokemon_go_reviews.json")


if __name__ == "__main__":
    main()