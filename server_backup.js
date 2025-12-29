const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");
const puppeteer = require("puppeteer-extra"); 
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

// Enable stealth mode
puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 7000;
// If you move this to a server later, this will auto-update to the server's URL
const BASE_URL = process.env.BASE_URL || `http://127.0.0.1:${PORT}`;

app.use(cors());

const builder = new addonBuilder({
    id: "org.bollywood.redirect",
    version: "2.1.0",
    name: "Bollywood Final",
    description: "Auto-Clicker with Direct Redirect",
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

// 1. SCRAPER (Finds the files)
builder.defineStreamHandler(async ({ type, id }) => {
    if (type !== "movie") return { streams: [] };
    
    const meta = await getTmdbId(id);
    if (!meta || !meta.tmdbId) return { streams: [] };
    console.log(`\n🎬 Request: ${meta.name} (TMDB: ${meta.tmdbId})`);

    let streams = [];
    let browser = null;

    try {
        // Launch Browser
        // Note: For a real server (Linux), you might need to change headless to "new"
        browser = await puppeteer.launch({
            headless: false, 
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        const page = await browser.newPage();
        const directUrl = `https://bollywood.eu.org/?type=movie&id=${meta.tmdbId}`;
        await page.goto(directUrl, { waitUntil: 'domcontentloaded' });

        // Auto-Click "View All Files"
        console.log("⏳ Checking for file list...");
        try {
            await page.waitForFunction(
                () => [...document.querySelectorAll('button, a')].some(b => b.innerText.includes('View All Files')),
                { timeout: 5000 }
            );
            await page.evaluate(() => {
                const buttons = [...document.querySelectorAll('button, a')];
                const viewButton = buttons.find(b => b.innerText.includes('View All Files'));
                if (viewButton) viewButton.click();
            });
        } catch (e) {}

        // Wait for files
        await page.waitForSelector('.file-result', { timeout: 6000 });
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

// 2. STREAM HANDLER (Redirects to real link)
app.all('/stream/:id', async (req, res) => {
    try {
        const fileId = req.params.id;
        
        // 1. Get the Real Link from API
        const apiUrl = `https://tga-hd.api.hashhackers.com/genLink?type=files&id=${fileId}`;
        const headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Referer": "https://bollywood.eu.org/",
            "Origin": "https://bollywood.eu.org"
        };

        // If Stremio is just checking (HEAD), we don't need the full link logic immediately if it saves time,
        // but we need the link to get the file size.
        const apiRes = await axios.get(apiUrl, { headers });
        const realUrl = apiRes.data.link || apiRes.data.downloadUrl || apiRes.data.url;

        if (!realUrl) return res.status(404).send("Link generation failed");

        // 2. Handle Stremio's Health Check (HEAD request)
        // We try to fetch the file size (metadata) and pass it to Stremio.
        if (req.method === 'HEAD') {
            try {
                const headRes = await axios.head(realUrl, { 
                    headers, 
                    validateStatus: () => true 
                });
                
                if (headRes.headers['content-length']) res.set('Content-Length', headRes.headers['content-length']);
                if (headRes.headers['content-type']) res.set('Content-Type', headRes.headers['content-type']);
                
                res.status(200).end();
                return;
            } catch (e) {
                // If checking fails, just say OK anyway so Stremio tries to play it
                res.status(200).end(); 
                return;
            }
        }

        // 3. Play the Video (Redirect)
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
    console.log(`🚀 Addon Ready!`);
    console.log(`🌍 Base URL: ${BASE_URL}`);
});