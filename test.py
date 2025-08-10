from bs4 import BeautifulSoup
import requests
import csv
import time
from urllib.parse import urljoin


def _pick_best_from_srcset(srcset: str | None) -> str | None:
    if not srcset:
        return None
    last = [part.strip() for part in srcset.split(",") if part.strip()][-1]
    return last.split()[0]


BASE_URL = "https://www.peppermayo.com"
LISTING_URL = "https://us.peppermayo.com/collections/new-arrivals"
def parse_products(html: str):
    soup = BeautifulSoup(html, "html.parser")
    products = []

    for card in soup.select(".product-item__body"):
        name_el = card.select_one(".product-item__name a")
        if not name_el:
            name_el = card.select_one(".product-item__image a")
        name = name_el.get_text(strip=True) if name_el else None

        link = urljoin(BASE_URL, name_el.get("href")) if name_el and name_el.get("href") else None

        price_el = card.select_one(".product-item__prices .price")
        price_raw = price_el.get_text(strip=True) if price_el else None
        if price_raw:
            price_clean = price_raw.replace("$", "").replace(",", "").strip()
            try:
                price = float(price_clean)
            except ValueError:
                price = price_clean
        else:
            price = None

        img = card.select_one(".product-item__image img")
        img_url = None
        if img:
            img_url = img.get("src")
            if not img_url or img_url.startswith("data:"):
                img_url = _pick_best_from_srcset(
                    img.get("srcset") or img.get("data-srcset")
                )

        products.append({
            "name": name,
            "price": price,
            "image": img_url,
            "link": link
        })

    return products


if __name__ == "__main__":


    list_resp = requests.get(LISTING_URL, timeout=20)
    list_resp.raise_for_status()

    soup = BeautifulSoup(list_resp.text, "html.parser")
    print(soup.select(".product-item"))
    #list_resp = requests.get(LISTING_URL, timeout=20)
    #list_resp.raise_for_status()

    #print(parse_products(list_resp.text))
