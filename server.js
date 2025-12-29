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
const BASE_URL = process.env.RENDER_EXTERNAL_URL || process.env.BASE_URL || `http://127.0.0.1:${PORT}`;

app.use(cors());

// Helper: Pause for X milliseconds
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const builder = new addonBuilder({
    id: "org.bollywood.patient",
    version: "3.5.0",
    name: "Bollywood Patient",
    description: "Calculated Wait Times for Series",
    resources: ["stream"],
    types: ["movie", "series"],
    catalogs: []
});

async function getTmdbId(imdbId, type) {
    try {
        const metaType = type === 'series' ? 'series' : 'movie';
        const url = `https://v3-cinemeta.strem.io/meta/${metaType}/${imdbId}.json`;
        const res = await axios.get(url);
        return { tmdbId: res.data.meta.moviedb_id, name: res.data.meta.name };
    } catch (e) { return null; }
}

builder.defineStreamHandler(async ({ type, id }) => {
    let streams = [];
    let browser = null;
    let imdbId, season, episode;

    if (type === "series") {
        [imdbId, season, episode] = id.split(":");
    } else {
        imdbId = id;
    }

    const meta = await getTmdbId(imdbId, type);
    if (!meta || !meta.tmdbId) return { streams: [] };

    const showName = meta.name;
    console.log(`\n🎬 Request: ${showName} ${type === 'series' ? `(S${season} E${episode})` : ''}`);

    try {
        const isProduction = process.env.NODE_ENV === 'production';
        
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

        // Enable CSS for correct button placement
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'font', 'media'].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        if (type === "series") {
            // --- SERIES LOGIC ---
            const encodedName = encodeURIComponent(showName);
            const directUrl = `https://bollywood.eu.org/?type=show_season&id=${meta.tmdbId}&season=${season}&name=${encodedName}`;
            console.log(`🌍 Navigating to: ${directUrl}`);
            
            // Wait for network idle
            await page.goto(directUrl, { waitUntil: 'networkidle2', timeout: 60000 });

            const episodeSelector = `#episode_${season}_${episode}`;
            console.log(`⏳ Searching for Episode ${episode} card...`);
            
            try {
                await page.waitForSelector(episodeSelector, { timeout: 20000 });
                console.log("✅ Card Found. Scrolling into view...");
                
                await page.evaluate((selector) => {
                    const element = document.querySelector(selector);
                    if (element) element.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }, episodeSelector);

                // --- INTELLIGENT WAIT ---
                // Calculate wait time: 2.5 seconds per previous episode
                // Episode 1 = 2.5s, Episode 5 = 12.5s wait
                const waitTime = parseInt(episode) * 2500;
                console.log(`⏳ Intelligent Wait: Pausing ${waitTime/1000}s for previous episodes to scan...`);
                await sleep(waitTime);

                // --- THE HAMMER STRATEGY (NOW WITH PATIENCE) ---
                let success = false;
                for (let attempt = 1; attempt <= 4; attempt++) {
                    console.log(`🖱️ Click Attempt ${attempt}...`);
                    
                    await page.evaluate((selector) => {
                        const card = document.querySelector(selector);
                        const buttons = [...card.querySelectorAll('button')]; 
                        const viewButton = buttons.find(b => b.innerText.includes('View All'));
                        if (viewButton) viewButton.click();
                    }, episodeSelector);

                    try {
                        await page.waitForSelector('.file-result', { timeout: 4000 });
                        console.log("🎉 Click worked! File list opened.");
                        success = true;
                        break; 
                    } catch (e) {
                        console.log("⚠️ Click failed. Retrying in 3s...");
                        await sleep(3000);
                    }
                }
                
                if (!success) console.log("❌ All click attempts failed.");

            } catch (e) {
                console.log(`ℹ️ Episode ${episode} not found.`);
                return { streams: [] };
            }

        } else {
            // --- MOVIE LOGIC (UNCHANGED) ---
            const directUrl = `https://bollywood.eu.org/?type=movie&id=${meta.tmdbId}`;
            await page.goto(directUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

            console.log("⏳ Checking for 'View All Files' button...");
            try {
                await page.waitForFunction(
                    () => [...document.querySelectorAll('button, a')].some(b => b.innerText.includes('View All Files')),
                    { timeout: 15000 }
                );
                await page.evaluate(() => {
                    const buttons = [...document.querySelectorAll('button, a')];
                    const viewButton = buttons.find(b => b.innerText.includes('View All Files'));
                    if (viewButton) viewButton.click();
                });
            } catch (e) {}
        }

        // --- SCRAPE RESULTS ---
        console.log("⏳ Waiting for file list (30s timeout)...");
        try {
            await page.waitForSelector('.file-result', { timeout: 30000 });
            
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

        } catch(e) {
             console.log("⚠️ File list did not appear (No streams found).");
        }

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
    console.log(`🚀 Addon Ready (Intelligent Wait)`);
    console.log(`🌍 Base URL: ${BASE_URL}`);
});