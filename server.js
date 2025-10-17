const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');
const fetch = require('node-fetch');
const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = 'jehad4'; // Hardcoded for simplicity; move to .env for production

// Middleware
app.use(express.json());
app.use('/downloads', express.static(path.join(__dirname, 'downloads')));

// Polyfill for waitForTimeout
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// API endpoint: GET /api/album/:model
app.get('/api/album/:model', async (req, res) => {
  try {
    const model = req.params.model;
    const cacheDir = path.join(__dirname, 'cache', model);
    const cacheFile = path.join(cacheDir, 'images.json');

    // Check cache
    try {
      const cachedData = await fs.readFile(cacheFile, 'utf8');
      const images = JSON.parse(cachedData);
      if (images.length > 0) {
        console.log(`Serving ${images.length} cached NSFW images for ${model}`);
        return res.json({ model, album: images, total: images.length, source: 'cache' });
      }
    } catch (e) {
      console.log(`No cache for ${model}, scraping...`);
    }

    let imageUrls = [];
    let attempts = 0;
    const maxAttempts = 2;

    // Launch Puppeteer with retries
    while (attempts < maxAttempts && imageUrls.length === 0) {
      attempts++;
      try {
        console.log(`Scraping attempt ${attempts}/${maxAttempts} for ${model}...`);
        const browser = await puppeteer.launch({
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-gpu',
            '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36'
          ]
        });
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 720 });

        // Try search and tags
        const searchUrl = `https://ahottie.net/?s=${encodeURIComponent(model)}`;
        const tagUrl = `https://ahottie.net/tags/${encodeURIComponent(model)}`;
        console.log(`Navigating to: ${searchUrl}`);
        await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });

        // Scroll and wait for dynamic content
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await delay(5000);

        // Extract gallery links
        let galleryLinks = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('a[href*="/20"], a.post-title, a[href*="/gallery/"]'))
            .map(a => a.href)
            .filter(href => href && href.includes('ahottie.net'))
            .slice(0, 5);
        });

        // Try tag page if no galleries
        if (galleryLinks.length === 0) {
          console.log(`No galleries in search, trying: ${tagUrl}`);
          await page.goto(tagUrl, { waitUntil: 'networkidle2', timeout: 30000 });
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await delay(5000);
          galleryLinks = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('a[href*="/20"], a.post-title, a[href*="/gallery/"]'))
              .map(a => a.href)
              .filter(href => href && href.includes('ahottie.net'))
              .slice(0, 5);
          });
        }

        console.log(`Found ${galleryLinks.length} gallery links for ${model}`);

        // Scrape images from search or tag page
        imageUrls = await page.evaluate(() => {
          const images = Array.from(document.querySelectorAll('img[src*="imgbox.com"], img[src*="wp-content"], .entry-content img, .post-thumbnail img, .wp-block-gallery img'));
          return images
            .map(img => img.src)
            .filter(src => src && /\.(jpg|jpeg|png|gif)$/i.test(src))
            .slice(0, 50);
        });

        // Try galleries
        for (const link of galleryLinks) {
          if (imageUrls.length >= 20) break;
          console.log(`Trying gallery: ${link}`);
          await page.goto(link, { waitUntil: 'networkidle2', timeout: 30000 });
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await delay(5000);
          const newUrls = await page.evaluate(() => {
            const images = Array.from(document.querySelectorAll('img[src*="imgbox.com"], img[src*="wp-content"], .entry-content img, .post-thumbnail img, .wp-block-gallery img'));
            return images
              .map(img => img.src)
              .filter(src => src && /\.(jpg|jpeg|png|gif)$/i.test(src))
              .slice(0, 50);
          });
          imageUrls.push(...newUrls);
        }

        await browser.close();
        console.log(`Puppeteer found ${imageUrls.length} images for ${model}`);
      } catch (puppeteerError) {
        console.error(`Puppeteer attempt ${attempts} failed: ${puppeteerError.message}`);
      }
    }

    // Create empty cache if no images
    if (imageUrls.length === 0) {
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(cacheFile, JSON.stringify([]));
      return res.status(404).json({
        error: `No NSFW images found for "${model}".`,
        suggestion: `Try "Mia Nanasawa" or "LinXingLan". Visit https://ahottie.net/?s=${encodeURIComponent(model)} to confirm.`
      });
    }

    // Format and cache
    const images = imageUrls.map((url, index) => ({
      id: index + 1,
      name: `nsfw_${model}_${index + 1}.${url.split('.').pop()}`,
      url,
      thumb: url
    }));

    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(cacheFile, JSON.stringify(images));

    res.json({ model, album: images, total: images.length, source: 'ahottie.net' });
  } catch (error) {
    console.error(`Error: ${error.message}`);
    res.status(500).json({ error: `Server error: ${error.message}` });
  }
});

// API endpoint: GET /api/nsfw/:model?apikey=jehad4
app.get('/api/nsfw/:model', async (req, res) => {
  try {
    const { model } = req.params;
    const { apikey } = req.query;

    // Validate API key
    if (apikey !== API_KEY) {
      return res.status(401).json({ error: 'Invalid or missing API key. Use ?apikey=jehad4' });
    }

    const cacheDir = path.join(__dirname, 'cache', model);
    const cacheFile = path.join(cacheDir, 'images.json');

    // Check cache
    let images = [];
    try {
      const cachedData = await fs.readFile(cacheFile, 'utf8');
      images = JSON.parse(cachedData);
    } catch (e) {
      // Trigger scraping if no cache
      const response = await new Promise(resolve => {
        const req = { params: { model } };
        const res = {
          json: data => resolve(data),
          status: code => ({ json: data => resolve({ status: code, error: data.error }) })
        };
        app.get('/api/album/:model')(req, res);
      });
      if (response.status === 404) {
        return res.status(404).json({ error: response.error });
      }
      images = response.album;
    }

    if (images.length === 0) {
      return res.status(404).json({ error: `No images found for "${model}". Call /api/album/${model} first.` });
    }

    // Pick random image
    const image = images[Math.floor(Math.random() * images.length)];
    const response = await fetch(image.url);
    if (!response.ok) {
      return res.status(404).json({ error: `Image not found: ${image.url} (HTTP ${response.status})` });
    }
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    if (!contentType.includes('image')) {
      return res.status(500).json({ error: 'API did not return an image' });
    }

    const buffer = await response.buffer();
    res.set('Content-Type', contentType);
    res.send(buffer);
  } catch (error) {
    console.error(`NSFW API error: ${error.message}`);
    res.status(500).json({ error: `NSFW API error: ${error.message}` });
  }
});

// Download single image
app.get('/download/:model/:imageId', async (req, res) => {
  try {
    const { model, imageId } = req.params;
    const cacheFile = path.join(__dirname, 'cache', model, 'images.json');
    let images = [];
    try {
      const cachedData = await fs.readFile(cacheFile, 'utf8');
      images = JSON.parse(cachedData);
    } catch (e) {
      return res.status(404).json({ error: `No cached images for ${model}. Call /api/album/${model} first.` });
    }

    const image = images.find(img => img.id == imageId);
    if (!image) return res.status(404).json({ error: `Image ID ${imageId} not found for ${model}` });

    const response = await fetch(image.url);
    if (!response.ok) return res.status(404).json({ error: `Image not found: ${image.url} (HTTP ${response.status})` });
    const buffer = await response.buffer();
    res.set('Content-Type', 'image/jpeg');
    res.set('Content-Disposition', `attachment; filename="${image.name}"`);
    res.send(buffer);
  } catch (error) {
    res.status(500).json({ error: `Download error: ${error.message}` });
  }
});

// Bulk download endpoint
app.get('/bulk-download/:model', async (req, res) => {
  try {
    const { model } = req.params;
    const cacheFile = path.join(__dirname, 'cache', model, 'images.json');
    let images = [];
    try {
      const cachedData = await fs.readFile(cacheFile, 'utf8');
      images = JSON.parse(cachedData);
    } catch (e) {
      return res.status(404).json({ error: `No cached images for ${model}. Call /api/album/${model} first.` });
    }

    const downloadDir = path.join(__dirname, 'downloads', model);
    await fs.mkdir(downloadDir, { recursive: true });

    for (const image of images) {
      const filePath = path.join(downloadDir, image.name);
      if (!(await fs.access(filePath).then(() => true).catch(() => false))) {
        const response = await fetch(image.url);
        if (response.ok) {
          const buffer = await response.buffer();
          await fs.writeFile(filePath, buffer);
          console.log(`Downloaded ${image.name} to ${filePath}`);
        }
      }
    }

    res.json({ model, message: `Images downloaded to /downloads/${model}. Access via /downloads/${model}/filename` });
  } catch (error) {
    res.status(500).json({ error: `Bulk download error: ${error.message}` });
  }
});

// Health check
app.get('/', (req, res) => res.send('NSFW Album API ready. Use /api/album/Mia Nanasawa, /api/nsfw/Mia Nanasawa?apikey=jehad4, /download/Mia Nanasawa/1, or /bulk-download/Mia Nanasawa'));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
