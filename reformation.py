from bs4 import BeautifulSoup
import requests
import csv
import time
from urllib.parse import urljoin

BASE_URL = "https://www.thereformation.com"
LISTING_URL = "https://www.thereformation.com/new"


def _pick_best_from_srcset(srcset: str | None) -> str | None:
    if not srcset:
        return None
    last = [part.strip() for part in srcset.split(",") if part.strip()][-1]
    return last.split()[0]

def parse_products(html: str):
    soup = BeautifulSoup(html, "html.parser")
    products = []

    for tile in soup.select(".product-tile[data-product-tile]"):
        name_el = tile.select_one(".product-tile__name")
        name = name_el.get_text(strip=True) if name_el else None

        link_el = tile.select_one(".product-tile__name-price-container a.product-tile__anchor")
        link = urljoin(BASE_URL, link_el.get("href")) if link_el and link_el.get("href") else None

        price_el = tile.select_one(".price .value")
        price_raw = (price_el.get("content") if price_el else None) or \
                    (price_el.get_text(strip=True) if price_el else None)
        if price_raw:
            price_clean = price_raw.replace("$", "").replace(",", "")
            try:
                price = float(price_clean)
            except ValueError:
                price = price_clean
        else:
            price = None

        img = tile.select_one("img.tile-image-primary") or tile.select_one("img.tile-image")
        img_url = None
        if img:
            img_url = img.get("src")
            if not img_url or img_url.startswith("data:"):
                img_url = _pick_best_from_srcset(
                    img.get("cl-data-srcset") or img.get("data-srcset") or img.get("srcset")
                )

        products.append({"name": name, "price": price, "image": img_url, "link": link})

    return products

def fetch_pdp_fit_details(url: str) -> str | None:

    if not url:
        return None

    try:
        resp = requests.get(url, timeout=25)
        resp.raise_for_status()
    except requests.RequestException:
        return None

    soup = BeautifulSoup(resp.text, "html.parser")

    chunks = []

    for el in soup.select(".pdp_fit-details-item"):
        classes = el.get("class", [])
        aria_hidden = el.get("aria-hidden")
        if "hidden" in classes or aria_hidden == "true":
            continue
        text = el.get_text(" ", strip=True)
        if text:
            chunks.append(text)

    model_info = soup.select_one(".model-info")
    if model_info:
        classes = model_info.get("class", [])
        aria_hidden = model_info.get("aria-hidden")
        if "hidden" not in classes and aria_hidden != "true":
            t = model_info.get_text(" ", strip=True)
            if t:
                chunks.append(t)

    seen = set()
    ordered = []
    for c in chunks:
        if c not in seen:
            seen.add(c)
            ordered.append(c)

    return " | ".join(ordered) if ordered else None

if __name__ == "__main__":
    list_resp = requests.get(LISTING_URL, timeout=20)
    list_resp.raise_for_status()

    products = parse_products(list_resp.text)

    for p in products:
        p["fit_details"] = fetch_pdp_fit_details(p.get("link"))
        time.sleep(0.4)

    with open("reformation.csv", "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=["name", "price", "image", "link", "fit_details"]
        )
        writer.writeheader()
        writer.writerows(products)

    print(f"Saved {len(products)} products to products.csv")
