const Parser = require('rss-parser');
const fs = require('fs');

const parser = new Parser({
  headers: {
    'User-Agent': 'ArtemisTelegramBot/1.0 (+https://github.com/giladi/artemis-bot)',
    'Accept': 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8'
  },
  timeout: 15000
});

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const FEED_URL = 'https://www.nasa.gov/rss/dyn/breaking_news.rss';
const MULTIMEDIA_URL = 'https://www.nasa.gov/artemis-ii-multimedia/';
const SENT_FILE = 'sent.json';
const MAX_MEDIA_ITEMS_PER_RUN = 4;

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

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeLower(value) {
  return normalizeText(value).toLowerCase();
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function looksLikeDirectImageUrl(url) {
  if (!url) return false;

  const cleanUrl = url.toLowerCase().split('?')[0];

  return (
    cleanUrl.endsWith('.jpg') ||
    cleanUrl.endsWith('.jpeg') ||
    cleanUrl.endsWith('.png') ||
    cleanUrl.endsWith('.webp')
  );
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

async function fetchFeedWithRetry() {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await parser.parseURL(FEED_URL);
    } catch (error) {
      const message = String(error.message || '');

      if (message.includes('429')) {
        console.warn(`NASA RSS returned 429 on attempt ${attempt}/${maxAttempts}.`);

        if (attempt < maxAttempts) {
          await sleep(attempt * 5000);
          continue;
        }

        console.warn('Skipping RSS for this run because NASA rate-limited the request.');
        return null;
      }

      throw error;
    }
  }

  return null;
}

async function getImageFromArticle(articleUrl) {
  try {
    const html = await fetchText(articleUrl);

    const ogImageMatch =
      html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i) ||
      html.match(/<meta\s+content="([^"]+)"\s+property="og:image"/i);

    if (ogImageMatch && ogImageMatch[1]) {
      return decodeHtmlEntities(ogImageMatch[1]);
    }

    return null;
  } catch (error) {
    console.error(`Failed to fetch article image from ${articleUrl}:`, error.message);
    return null;
  }
}

function isRelevantRssItem(item) {
  const title = normalizeLower(item.title);
  const content = normalizeLower(item.contentSnippet || item.content);

  return title.includes('artemis') || content.includes('artemis');
}

async function sendRssItem(title, link, imageUrl) {
  const caption = `🚀 ${title}\n\n${link}`;

  if (imageUrl && looksLikeDirectImageUrl(imageUrl)) {
    try {
      await sendTelegramPhoto(imageUrl, caption);
      console.log(`Sent RSS photo update: ${title}`);
      return;
    } catch (error) {
      console.error(`RSS photo send failed for "${title}", falling back to text:`, error.message);
    }
  }

  await sendTelegramMessage(caption);
  console.log(`Sent RSS text update: ${title}`);
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

function extractNasaMediaLinks(html) {
  const results = [];

  const absoluteRegex = /https:\/\/www\.nasa\.gov\/(?:image-article|gallery)\/[a-z0-9\-\/]+/gi;
  const relativeRegex = /href="(\/(?:image-article|gallery)\/[^"]+)"/gi;

  for (const match of html.matchAll(absoluteRegex)) {
    results.push(match[0]);
  }

  for (const match of html.matchAll(relativeRegex)) {
    results.push(`https://www.nasa.gov${match[1]}`);
  }

  return uniqueBy(results, (url) => url);
}

function scoreMediaPage(page) {
  const title = normalizeLower(page.title);
  const description = normalizeLower(page.description);
  const url = normalizeLower(page.url);
  const text = `${title} ${description} ${url}`;

  let score = 0;

  if (text.includes('artemis ii')) score += 18;
  if (text.includes('artemis')) score += 8;
  if (text.includes('orion')) score += 8;
  if (text.includes('moon')) score += 7;
  if (text.includes('earth')) score += 7;
  if (text.includes('crew')) score += 5;
  if (text.includes('astronaut')) score += 5;
  if (text.includes('flight day')) score += 5;
  if (text.includes('journey')) score += 3;
  if (text.includes('hello, world')) score += 10;
  if (text.includes('thinking of you, earth')) score += 10;
  if (text.includes('to the moon')) score += 8;
  if (text.includes('window')) score += 3;
  if (text.includes('imagery')) score += 3;

  if (text.includes('podcast')) score -= 10;
  if (text.includes('audio')) score -= 10;
  if (text.includes('video')) score -= 4;
  if (text.includes('virtual background')) score -= 12;
  if (text.includes('wallpaper')) score -= 8;

  return score;
}

async function fetchMediaPageDetails(url) {
  try {
    const html = await fetchText(url);

    const ogTitleMatch =
      html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i) ||
      html.match(/<meta\s+content="([^"]+)"\s+property="og:title"/i);

    const ogImageMatch =
      html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i) ||
      html.match(/<meta\s+content="([^"]+)"\s+property="og:image"/i);

    const ogDescriptionMatch =
      html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i) ||
      html.match(/<meta\s+content="([^"]+)"\s+property="og:description"/i);

    const publishedMatch =
      html.match(/<meta\s+property="article:published_time"\s+content="([^"]+)"/i) ||
      html.match(/<meta\s+content="([^"]+)"\s+property="article:published_time"/i);

    const title = ogTitleMatch ? decodeHtmlEntities(ogTitleMatch[1]) : '';
    const imageUrl = ogImageMatch ? decodeHtmlEntities(ogImageMatch[1]) : '';
    const description = ogDescriptionMatch ? decodeHtmlEntities(ogDescriptionMatch[1]) : '';
    const publishedTime = publishedMatch ? decodeHtmlEntities(publishedMatch[1]) : '';

    if (!imageUrl || !looksLikeDirectImageUrl(imageUrl)) {
      return null;
    }

    const page = {
      url,
      title,
      imageUrl,
      description,
      publishedTime
    };

    page.score = scoreMediaPage(page);
    return page;
  } catch (error) {
    console.error(`Failed to fetch NASA media page "${url}":`, error.message);
    return null;
  }
}

function sortMediaPages(items) {
  return [...items].sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }

    const aTime = Date.parse(a.publishedTime || '') || 0;
    const bTime = Date.parse(b.publishedTime || '') || 0;

    return bTime - aTime;
  });
}

async function fetchTopNasaMultimediaItems() {
  console.log('Checking NASA Artemis II multimedia page...');

  let multimediaHtml;
  try {
    multimediaHtml = await fetchText(MULTIMEDIA_URL);
  } catch (error) {
    console.error('Failed to fetch multimedia page:', error.message);
    return [];
  }

  const candidateUrls = extractNasaMediaLinks(multimediaHtml);

  if (candidateUrls.length === 0) {
    console.log('No NASA multimedia links found.');
    return [];
  }

  const limitedCandidates = candidateUrls.slice(0, 20);
  const pages = [];

  for (const url of limitedCandidates) {
    const details = await fetchMediaPageDetails(url);

    if (details && details.score >= 10) {
      pages.push(details);
    }

    await sleep(700);
  }

  return sortMediaPages(uniqueBy(pages, (item) => item.url)).slice(0, MAX_MEDIA_ITEMS_PER_RUN);
}

async function sendMediaItem(item) {
  const caption = `📸 ${item.title}\n\n${item.url}`;

  try {
    await sendTelegramPhoto(item.imageUrl, caption);
    console.log(`Sent NASA multimedia image: ${item.title}`);
    return;
  } catch (error) {
    console.error(`NASA multimedia photo send failed for "${item.title}", falling back to text:`, error.message);
  }

  await sendTelegramMessage(caption);
  console.log(`Sent NASA multimedia text update: ${item.title}`);
}

async function processRss(sentItems) {
  console.log('Checking NASA RSS feed...');

  const feed = await fetchFeedWithRetry();

  if (!feed) {
    console.log('No RSS feed data available for this run.');
    return 0;
  }

  const relevantItems = (feed.items || []).filter(isRelevantRssItem);
  let sentNow = 0;

  for (const item of relevantItems.reverse()) {
    const uniqueId = `rss:${item.guid || item.id || item.link || item.title}`;

    if (!uniqueId || sentItems.has(uniqueId)) {
      continue;
    }

    const title = item.title || 'New Artemis update';
    const link = item.link || '';

    let imageUrl = null;

    if (item.enclosure && item.enclosure.url) {
      imageUrl = item.enclosure.url;
    }

    if (!imageUrl && link) {
      imageUrl = await getImageFromArticle(link);
    }

    try {
      await sendRssItem(title, link, imageUrl);
      sentItems.add(uniqueId);
      sentNow += 1;
      await sleep(1200);
    } catch (error) {
      console.error(`Failed to send RSS item "${title}":`, error.message);
    }
  }

  return sentNow;
}

async function processNasaMultimedia(sentItems) {
  const items = await fetchTopNasaMultimediaItems();
  let sentNow = 0;

  for (const item of items) {
    const uniqueId = `media:${item.url}`;

    if (!uniqueId || sentItems.has(uniqueId)) {
      continue;
    }

    try {
      await sendMediaItem(item);
      sentItems.add(uniqueId);
      sentNow += 1;
      await sleep(1200);
    } catch (error) {
      console.error(`Failed to send NASA multimedia item "${item.title}":`, error.message);
    }
  }

  return sentNow;
}

async function run() {
  const sentItems = loadSentItems();

  let rssCount = 0;
  let mediaCount = 0;

  try {
    rssCount = await processRss(sentItems);
  } catch (error) {
    console.error('RSS processing error:', error.message);
  }

  try {
    mediaCount = await processNasaMultimedia(sentItems);
  } catch (error) {
    console.error('NASA multimedia processing error:', error.message);
  }

  saveSentItems(sentItems);
  console.log(`Done. Sent ${rssCount} RSS update(s) and ${mediaCount} NASA multimedia image update(s).`);
}

run().catch((error) => {
  console.error('Fatal error:', error.message);
  process.exit(1);
});