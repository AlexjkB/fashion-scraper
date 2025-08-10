import puppeteer from "puppeteer";

const BASE_URL = "https://us.peppermayo.com";
const LISTING_URL = `${BASE_URL}/collections/new-arrivals`;

async function scrapePeppermayo() {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  console.log("Loading listing page...");
  await page.goto(LISTING_URL, { waitUntil: "networkidle2" });

  // Wait for JS-rendered products
  await page.waitForSelector(".product-item__body");

  // Extract basic product info from listing
  const products = await page.$$eval(".product-item__body", (cards) =>
    cards.map((card) => {
      const nameEl = card.querySelector(".product-item__name a") || card.querySelector(".product-item__image a");
      const name = nameEl?.textContent?.trim() || null;
      const link = nameEl?.getAttribute("href") ? new URL(nameEl.getAttribute("href"), "https://us.peppermayo.com").href : null;
      const priceEl = card.querySelector(".product-item__prices .price");
      const priceRaw = priceEl?.textContent?.trim() || null;
      const price = priceRaw ? parseFloat(priceRaw.replace(/[$,]/g, "")) : null;
      const imgEl = card.querySelector(".product-item__image img");
      const image = imgEl?.getAttribute("src") || imgEl?.getAttribute("data-src") || null;
      return { name, link, price, image };
    })
  );

  console.log(`Found ${products.length} products. Fetching PDP descriptions...`);

  // Visit each product and scrape description block
  for (const product of products) {
    if (!product.link) continue;
    const pdp = await browser.newPage();
    await pdp.goto(product.link, { waitUntil: "networkidle2" });

    // Get text between first and second .spaces
    product.fit_details = await pdp.evaluate(() => {
      const spaces = document.querySelectorAll("div.spaces");
      if (spaces.length >= 2) {
        const chunks = [];
        let cur = spaces[0].nextSibling;
        while (cur && cur !== spaces[1]) {
          if (cur.nodeType === Node.ELEMENT_NODE) {
            if (cur.tagName === "P") {
              chunks.push(cur.innerText.trim());
            } else if (["UL", "OL"].includes(cur.tagName)) {
              const items = Array.from(cur.querySelectorAll("li")).map((li) => `- ${li.innerText.trim()}`);
              chunks.push(items.join("\n"));
            } else {
              const ps = cur.querySelectorAll("p");
              ps.forEach((p) => chunks.push(p.innerText.trim()));
            }
          }
          cur = cur.nextSibling;
        }
        return chunks.filter(Boolean).join("\n\n");
      }
      return null;
    });

    await pdp.close();
  }

  console.log(products);
  await browser.close();
}

scrapePeppermayo();
