from bs4 import BeautifulSoup
import requests
import csv
import time
from urllib.parse import urljoin

BASE_URL = "https://www.peppermayo.com"
LISTING_URL = "https://us.peppermayo.com/collections/new-arrivals"


def _pick_best_from_srcset(srcset: str | None) -> str | None:
    if not srcset:
        return None
    last = [part.strip() for part in srcset.split(",") if part.strip()][-1]
    return last.split()[0]

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

def _normalize_multiline(text: str) -> str:
    text = re.sub(r'\r\n?', '\n', text)
    text = "\n".join(line.strip() for line in text.split("\n"))
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()

def _text_from_fragment(fragment) -> str:
    for br in fragment.find_all("br"):
        br.replace_with("\n")
    return fragment.get_text("\n", strip=True)

def extract_peppermayo_pdp_info(html: str) -> str | None:
    soup = BeautifulSoup(html, "html.parser")

    spaces = soup.select("div.spaces")
    if len(spaces) >= 2:
        start, end = spaces[0], spaces[1]
        cur = start.next_sibling
        chunks = []
        while cur and cur is not end:
            if getattr(cur, "name", None):
                if cur.name == "p":
                    chunks.append(_text_from_fragment(cur))
                elif cur.name in ("ul", "ol"):
                    items = [li.get_text(" ", strip=True) for li in cur.select("li")]
                    if items:
                        chunks.append("\n".join(f"- {it}" for it in items))
                else:
                    ps = cur.select("p")
                    if ps:
                        for p in ps:
                            chunks.append(_text_from_fragment(p))
            cur = cur.next_sibling

        text = "\n\n".join([c for c in (s.strip() for s in chunks) if c])
        return _normalize_multiline(text) or None

    fallback = soup.select_one(
        ".product__description, .product-description, .product__details, "
        ".rte.product__description, [data-product-description]"
    )
    if fallback:
        for br in fallback.find_all("br"):
            br.replace_with("\n")
        return _normalize_multiline(fallback.get_text("\n", strip=True)) or None

    return None

def fetch_peppermayo_pdp_info(url: str) -> str | None:
    try:
        r = requests.get(url, timeout=25)
        r.raise_for_status()
    except requests.RequestException:
        return None
    return extract_peppermayo_pdp_info(r.text)

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
