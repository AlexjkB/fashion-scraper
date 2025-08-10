// peppermayo.mjs
import fs from "fs/promises";
import path from "path";
import puppeteer from "puppeteer";

const BASE_URL = "https://us.peppermayo.com";
const LISTING_URL = `${BASE_URL}/collections/new-arrivals`;
const OUT_CSV = "peppermayo_new_arrivals.csv";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanText(text) {
  if (!text) return "";
  return String(text).replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

function csvEscape(v) {
  const s = v == null ? "" : String(v);
  if (/[,"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function saveCSV(rows) {
  const header = ["name", "price", "image", "link", "fit_details"];
  const lines = [
    header.join(","),
    ...rows.map((r) =>
      [
        csvEscape(r.name),
        csvEscape(r.price),
        csvEscape(r.image),
        csvEscape(r.link),
        csvEscape(cleanText(r.fit_details)), 
      ].join(",")
    ),
  ];
  await fs.writeFile(path.resolve(OUT_CSV), lines.join("\n"), "utf8");
  console.log(`Saved ${rows.length} products to ${OUT_CSV}`);
}

async function safeGoto(page, url, { tries = 3 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
      return;
    } catch (e) {
      lastErr = e;
      const backoff = 1000 * (i + 1);
      console.warn(`goto retry ${i + 1}/${tries} after ${backoff}ms:`, e.message);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

async function autoScroll(page, { step = 800, delay = 100 } = {}) {
  await page.evaluate(async ({ step, delay }) => {
    await new Promise((resolve) => {
      let total = 0;
      const timer = setInterval(() => {
        const root = document.scrollingElement || document.documentElement;
        const { scrollHeight } = root;
        window.scrollBy(0, step);
        total += step;
        if (total >= scrollHeight - window.innerHeight - 2) {
          clearInterval(timer);
          resolve();
        }
      }, delay);
    });
  }, { step, delay });
}

async function extractFitDetailsOnPDP(page) {
  return page.evaluate(() => {
    const spaces = document.querySelectorAll("div.spaces");

    function collectBetweenSpaces() {
      if (spaces.length >= 2) {
        const chunks = [];
        let cur = spaces[0].nextSibling;
        while (cur && cur !== spaces[1]) {
          if (cur.nodeType === Node.ELEMENT_NODE) {
            const el = cur;
            if (el.tagName === "P") {
              const t = el.innerText.trim();
              if (t) chunks.push(t);
            } else if (["UL", "OL"].includes(el.tagName)) {
              const items = Array.from(el.querySelectorAll("li"))
                .map((li) => `- ${li.innerText.trim()}`);
              if (items.length) chunks.push(items.join("\n"));
            } else {
              el.querySelectorAll("p").forEach((p) => {
                const t = p.innerText.trim();
                if (t) chunks.push(t);
              });
            }
          }
          cur = cur.nextSibling;
        }
        return chunks.filter(Boolean).join("\n\n") || null;
      }
      return null;
    }

    return (
      collectBetweenSpaces() ||
      document.querySelector(
        ".product__description, .product-description, .product__details, .rte.product__description, [data-product-description]"
      )?.innerText.trim() ||
      null
    );
  });
}

async function scrapePeppermayo() {
  const browser = await puppeteer.launch({
    headless: false, 
    defaultViewport: { width: 1366, height: 900 },
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(90000);
  await page.setUserAgent(UA);
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

  page.on("console", (msg) => {
    if (["error", "warning"].includes(msg.type())) {
      console.log("PAGE LOG:", msg.type(), msg.text());
    }
  });

  console.log("Loading listing...");
  await safeGoto(page, LISTING_URL);
  await autoScroll(page);
  await page
    .waitForSelector(".product-item__body", { timeout: 30000 })
    .catch(() => console.warn("product-item__body not found within 30s"));

  const products = await page.$$eval(".product-item__body", (cards) =>
    cards.map((card) => {
      const nameEl =
        card.querySelector(".product-item__name a") ||
        card.querySelector(".product-item__image a");
      const name = nameEl?.textContent?.trim() || null;
      const href = nameEl?.getAttribute("href") || null;
      const link = href ? new URL(href, location.origin).href : null;

      const priceEl = card.querySelector(".product-item__prices .price");
      const priceText = priceEl?.textContent?.trim() || null;
      const price = priceText ? parseFloat(priceText.replace(/[^0-9.]/g, "")) : null;

      const imgEl = card.querySelector(".product-item__image img");
      let image =
        imgEl?.getAttribute("src") ||
        imgEl?.getAttribute("data-src") ||
        imgEl?.getAttribute("data-srcset") ||
        null;
      if (image && image.startsWith("//")) image = "https:" + image;

      return { name, link, price, image };
    })
  );

  console.log(`Found ${products.length} products.`);

  if (products.length === 0) {
    await page.screenshot({ path: "listing_debug.png", fullPage: true });
    console.warn("Saved listing_debug.png — inspect to see what loaded.");
  }

  const CONCURRENCY = 4;
  let idx = 0;

  async function worker() {
    while (idx < products.length) {
      const i = idx++;
      const p = products[i];
      if (!p?.link) continue;

      const tab = await browser.newPage();
      tab.setDefaultNavigationTimeout(90000);
      await tab.setUserAgent(UA);
      await tab.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

      try {
        await safeGoto(tab, p.link);
        p.fit_details = await extractFitDetailsOnPDP(tab);
      } catch (e) {
        console.warn("PDP failed:", p.link, e.message);
        p.fit_details = null;
      } finally {
        await tab.close();
        await sleep(200);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, products.length) }, () => worker())
  );

  await browser.close();
  await saveCSV(products);
}

(async () => {
  try {
    await scrapePeppermayo();
  } catch (e) {
    console.error("Scrape failed:", e);
    process.exit(1);
  }
})();
