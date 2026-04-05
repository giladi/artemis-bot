const fs = require('fs');

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const GALLERY_URL = 'https://www.nasa.gov/gallery/journey-to-the-moon/';
const SENT_FILE = 'sent.json';
const MAX_ITEMS_PER_RUN = 10;

if (!BOT_TOKEN || !CHAT_ID) {
  console.error('Missing BOT_TOKEN or CHAT_ID environment variables.');
  process.exit(1);
}

function loadSentItems() {
  try {
    if (!fs.existsSync(SENT_FILE)) {
      return new Set();
    }

    const raw = fs.readFileSync(SENT_FILE, 'utf8');
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      return new Set();
    }

    return new Set(parsed);
  } catch (error) {
    console.error('Failed to load sent.json:', error.message);
    return new Set();
  }
}

function saveSentItems(sentItems) {
  try {
    fs.writeFileSync(SENT_FILE, JSON.stringify([...sentItems], null, 2), 'utf8');
  } catch (error) {
    console.error('Failed to save sent.json:', error.message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function stripHtml(html) {
  return decodeHtmlEntities(String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'ArtemisTelegramBot/1.0 (+https://github.com/giladi/artemis-bot)',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }
  });

  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status}`);
  }

  return response.text();
}

async function sendTelegramPhoto(photoUrl, caption) {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      photo: photoUrl,
      caption: caption.slice(0, 1024)
    })
  });

  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw new Error(`Telegram sendPhoto failed: ${JSON.stringify(result)}`);
  }

  return result;
}

async function sendTelegramMessage(text) {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text
    })
  });

  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw new Error(`Telegram sendMessage failed: ${JSON.stringify(result)}`);
  }

  return result;
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const result = [];

  for (const item of items) {
    const key = keyFn(item);

    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(item);
  }

  return result;
}

function extractImageDetailLinks(html) {
  const results = [];

  const absoluteRegex = /https:\/\/www\.nasa\.gov\/image-detail\/[a-z0-9\-\/]+/gi;
  const relativeRegex = /href="(\/image-detail\/[^"]+)"/gi;

  for (const match of html.matchAll(absoluteRegex)) {
    results.push(match[0]);
  }

  for (const match of html.matchAll(relativeRegex)) {
    results.push(`https://www.nasa.gov${match[1]}`);
  }

  return uniqueBy(results, (url) => url);
}

function extractMetaContent(html, propertyName) {
  const patterns = [
    new RegExp(`<meta\\s+property="${propertyName}"\\s+content="([^"]+)"`, 'i'),
    new RegExp(`<meta\\s+content="([^"]+)"\\s+property="${propertyName}"`, 'i'),
    new RegExp(`<meta\\s+name="${propertyName}"\\s+content="([^"]+)"`, 'i'),
    new RegExp(`<meta\\s+content="([^"]+)"\\s+name="${propertyName}"`, 'i')
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      return decodeHtmlEntities(match[1]);
    }
  }

  return '';
}

function extractHeading(html) {
  const match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return match ? stripHtml(match[1]) : '';
}

function extractDescriptionParagraph(html) {
  const lines = html.split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (/<h1[^>]*>/i.test(line) || /^#\s+/i.test(line.trim())) {
      for (let j = i + 1; j < Math.min(i + 12, lines.length); j += 1) {
        const candidate = stripHtml(lines[j]);
        if (candidate && !candidate.startsWith('Image Credit') && !candidate.startsWith('Taken ')) {
          return candidate;
        }
      }
    }
  }

  return '';
}

function extractDownloadUrl(html) {
  const match = html.match(/href="(https:\/\/images-assets\.nasa\.gov\/[^"]+)"/i);
  return match ? decodeHtmlEntities(match[1]) : '';
}

function buildCaption(item) {
  const parts = [`📸 ${item.title}`];

  if (item.description) {
    parts.push(item.description);
  }

  parts.push(item.pageUrl);

  return parts.join('\n\n');
}

async function fetchGalleryItems() {
  console.log('Checking Journey to the Moon gallery...');

  const galleryHtml = await fetchText(GALLERY_URL);
  const detailUrls = extractImageDetailLinks(galleryHtml);

  console.log(`Found ${detailUrls.length} image detail link(s) on the gallery page.`);

  return detailUrls.slice(0, MAX_ITEMS_PER_RUN);
}

async function fetchImageDetails(pageUrl) {
  try {
    const html = await fetchText(pageUrl);

    const ogTitle = extractMetaContent(html, 'og:title');
    const ogDescription = extractMetaContent(html, 'og:description');
    const title = ogTitle || extractHeading(html) || 'NASA Artemis image';
    const description = ogDescription || extractDescriptionParagraph(html) || '';
    const downloadUrl = extractDownloadUrl(html);
    const ogImage = extractMetaContent(html, 'og:image');

    const imageUrl = downloadUrl || ogImage;

    return {
      pageUrl,
      title,
      description,
      imageUrl
    };
  } catch (error) {
    console.error(`Failed to fetch image details from ${pageUrl}:`, error.message);
    return null;
  }
}

async function sendGalleryItem(item) {
  const caption = buildCaption(item);

  if (item.imageUrl) {
    try {
      await sendTelegramPhoto(item.imageUrl, caption);
      console.log(`Sent image: ${item.title}`);
      return true;
    } catch (error) {
      console.error(`Photo send failed for "${item.title}", falling back to text:`, error.message);
    }
  }

  await sendTelegramMessage(caption);
  console.log(`Sent text only: ${item.title}`);
  return true;
}

async function run() {
  const sentItems = loadSentItems();
  const detailUrls = await fetchGalleryItems();

  let sentNow = 0;

  for (const pageUrl of detailUrls) {
    const uniqueId = `journey:${pageUrl}`;

    if (sentItems.has(uniqueId)) {
      continue;
    }

    const item = await fetchImageDetails(pageUrl);

    if (!item) {
      continue;
    }

    try {
      await sendGalleryItem(item);
      sentItems.add(uniqueId);
      sentNow += 1;
      await sleep(1200);
    } catch (error) {
      console.error(`Failed to send gallery item "${pageUrl}":`, error.message);
    }
  }

  saveSentItems(sentItems);
  console.log(`Done. Sent ${sentNow} new gallery item(s).`);
}

run().catch((error) => {
  console.error('Fatal error:', error.message);
  process.exit(1);
});