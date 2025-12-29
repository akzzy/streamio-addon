const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");
const puppeteer = require("puppeteer-extra"); 
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 7000;

// FIX: Use Render's external URL if available, otherwise localhost
const BASE_URL = process.env.RENDER_EXTERNAL_URL || process.env.BASE_URL || `http://127.0.0.1:${PORT}`;

app.use(cors());

const builder = new addonBuilder({
    id: "org.bollywood.render",
    version: "2.3.0",
    name: "Bollywood Cloud",
    description: "Cloud-hosted addon",
    resources: ["stream"],
    types: ["movie"],
    catalogs: []
});

async function getTmdbId(imdbId) {
    try {
        const url = `https://v3-cinemeta.strem.io/meta/movie/${imdbId}.json`;
        const res = await axios.get(url);
        return { tmdbId: res.data.meta.moviedb_id, name: res.data.meta.name };
    } catch (e) { return null; }
}

builder.defineStreamHandler(async ({ type, id }) => {
    if (type !== "movie") return { streams: [] };
    
    const meta = await getTmdbId(id);
    if (!meta || !meta.tmdbId) return { streams: [] };
    console.log(`\n🎬 Request: ${meta.name} (TMDB: ${meta.tmdbId})`);

    let streams = [];
    let browser = null;

    try {
        const isProduction = process.env.NODE_ENV === 'production';

        // FIX: Removed '--single-process' which causes crashes on Render
        browser = await puppeteer.launch({
            headless: isProduction ? "new" : false, 
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu'
            ]
        });

        const page = await browser.newPage();
        
        // Optimizations to save memory/bandwidth
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        const directUrl = `https://bollywood.eu.org/?type=movie&id=${meta.tmdbId}`;
        await page.goto(directUrl, { waitUntil: 'domcontentloaded' });

        // Auto-Clicker
        console.log("⏳ Checking for files...");
        try {
            await page.waitForFunction(
                () => [...document.querySelectorAll('button, a')].some(b => b.innerText.includes('View All Files')),
                { timeout: 4000 }
            );
            await page.evaluate(() => {
                const buttons = [...document.querySelectorAll('button, a')];
                const viewButton = buttons.find(b => b.innerText.includes('View All Files'));
                if (viewButton) viewButton.click();
            });
        } catch (e) {}

        try {
            await page.waitForSelector('.file-result', { timeout: 6000 });
        } catch (e) {
            console.log("⚠️ Selector timeout (Files might be missing or slow).");
        }

        const content = await page.content();
        const $ = cheerio.load(content);

        $(".file-result").each((i, element) => {
            const fileName = $(element).find(".file-name").text().trim();
            const fileSize = $(element).find("p:contains('Size:')").text().replace("Size:", "").trim();
            const buttonHtml = $(element).find("button.download-button").attr("onclick");
            const match = buttonHtml ? buttonHtml.match(/generateFileLink\('([^']+)'\)/) : null;

            if (fileName && match && match[1]) {
                streams.push({
                    title: `${fileName}\n📦 ${fileSize}`,
                    url: `${BASE_URL}/stream/${match[1]}` 
                });
            }
        });
        console.log(`✅ Success! Found ${streams.length} files.`);

    } catch (error) {
        console.error("❌ Browser Error:", error.message);
    } finally {
        if (browser) await browser.close();
    }

    return { streams: streams };
});

app.all('/stream/:id', async (req, res) => {
    try {
        const fileId = req.params.id;
        const apiUrl = `https://tga-hd.api.hashhackers.com/genLink?type=files&id=${fileId}`;
        const headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Referer": "https://bollywood.eu.org/",
            "Origin": "https://bollywood.eu.org"
        };

        const apiRes = await axios.get(apiUrl, { headers });
        const realUrl = apiRes.data.link || apiRes.data.downloadUrl || apiRes.data.url;

        if (!realUrl) return res.status(404).send("Link generation failed");

        if (req.method === 'HEAD') {
            try {
                const headRes = await axios.head(realUrl, { headers, validateStatus: () => true });
                if (headRes.headers['content-length']) res.set('Content-Length', headRes.headers['content-length']);
                if (headRes.headers['content-type']) res.set('Content-Type', headRes.headers['content-type']);
                res.status(200).end();
                return;
            } catch (e) {
                res.status(200).end(); 
                return;
            }
        }

        console.log(`🔗 Redirecting to: ${realUrl}`);
        res.redirect(302, realUrl);

    } catch (e) {
        console.error("Link Error:", e.message);
        res.status(500).send("Error");
    }
});

const addonInterface = builder.getInterface();
const addonRouter = getRouter(addonInterface);
app.use("/", addonRouter);

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🌍 Base URL: ${BASE_URL}`);
});