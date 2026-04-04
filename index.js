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
const SENT_FILE = 'sent.json';
const MAX_IMAGES_PER_RUN = 3;

const NASA_IMAGE_QUERIES = [
  'artemis ii',
  'artemis orion moon',
  'artemis astronauts',
  'orion spacecraft moon'
];

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

async function fetchFeedWithRetry() {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await parser.parseURL(FEED_URL);
    } catch (error) {
      const message = String(error.message || '');

      if (message.includes('429')) {
        console.warn(`NASA feed returned 429 on attempt ${attempt}/${maxAttempts}.`);

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
    const response = await fetch(articleUrl, {
      headers: {
        'User-Agent': 'ArtemisTelegramBot/1.0 (+https://github.com/giladi/artemis-bot)'
      }
    });

    const html = await response.text();

    const ogImageMatch =
      html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i) ||
      html.match(/<meta\s+content="([^"]+)"\s+property="og:image"/i);

    if (ogImageMatch && ogImageMatch[1]) {
      return ogImageMatch[1];
    }

    return null;
  } catch (error) {
    console.error(`Failed to fetch article image from ${articleUrl}:`, error.message);
    return null;
  }
}

function isRelevantRssItem(item) {
  const title = (item.title || '').toLowerCase();
  const content = (item.contentSnippet || item.content || '').toLowerCase();

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

function normalizeText(value) {
  return String(value || '').toLowerCase();
}

function parseDateToMs(dateString) {
  if (!dateString) return null;

  const ms = Date.parse(dateString);
  return Number.isNaN(ms) ? null : ms;
}

function getRecencyScore(dateString) {
  const createdMs = parseDateToMs(dateString);
  if (!createdMs) return 0;

  const ageDays = (Date.now() - createdMs) / (1000 * 60 * 60 * 24);

  if (ageDays <= 2) return 10;
  if (ageDays <= 7) return 8;
  if (ageDays <= 14) return 6;
  if (ageDays <= 30) return 4;
  if (ageDays <= 90) return 2;

  return 0;
}

function scoreNasaImageItem(item) {
  const data = item.data || {};
  const links = item.links || [];
  const title = normalizeText(data.title);
  const description = normalizeText(data.description);
  const keywords = Array.isArray(data.keywords) ? data.keywords.map(normalizeText).join(' ') : '';
  const photographer = normalizeText(data.photographer);
  const center = normalizeText(data.center);

  const text = `${title} ${description} ${keywords} ${photographer} ${center}`;

  let score = 0;

  if (!text.includes('artemis') && !text.includes('orion')) {
    return -999;
  }

  if (text.includes('artemis ii')) score += 18;
  if (text.includes('artemis 2')) score += 18;
  if (text.includes('artemis')) score += 6;
  if (text.includes('orion')) score += 8;

  if (text.includes('astronaut')) score += 6;
  if (text.includes('crew')) score += 8;
  if (text.includes('moon')) score += 7;
  if (text.includes('lunar')) score += 7;
  if (text.includes('earth')) score += 6;
  if (text.includes('imagery')) score += 4;
  if (text.includes('inside')) score += 3;
  if (text.includes('spacecraft')) score += 5;
  if (text.includes('capsule')) score += 4;
  if (text.includes('flight')) score += 4;
  if (text.includes('mission')) score += 3;
  if (text.includes('far side')) score += 4;
  if (text.includes('moonbound')) score += 6;

  if (text.includes('poster')) score -= 15;
  if (text.includes('logo')) score -= 18;
  if (text.includes('patch')) score -= 14;
  if (text.includes('insignia')) score -= 12;
  if (text.includes('graphic')) score -= 12;
  if (text.includes('illustration')) score -= 16;
  if (text.includes('infographic')) score -= 16;
  if (text.includes('rendering')) score -= 14;
  if (text.includes('artist')) score -= 10;
  if (text.includes('concept')) score -= 10;

  score += getRecencyScore(data.date_created);

  const imageLink = links.find((link) => normalizeText(link.render) === 'image' && looksLikeDirectImageUrl(link.href));
  if (imageLink) {
    score += 4;
  }

  return score;
}

function buildNasaLibraryCaption(item) {
  const data = item.data || {};
  const title = data.title || 'New Artemis image';
  const nasaUrl = item.nasaUrl || 'https://images.nasa.gov/';

  return `📸 ${title}\n\n${nasaUrl}`;
}

function dedupeByKey(items, keyFn) {
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

async function fetchNasaImageQuery(query) {
  const url = `https://images-api.nasa.gov/search?q=${encodeURIComponent(query)}&media_type=image`;

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'ArtemisTelegramBot/1.0 (+https://github.com/giladi/artemis-bot)',
      'Accept': 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`NASA image API returned ${response.status} for query "${query}"`);
  }

  const json = await response.json();
  const items = json?.collection?.items || [];

  return items.map((item) => {
    const data = Array.isArray(item.data) && item.data.length > 0 ? item.data[0] : {};
    const links = Array.isArray(item.links) ? item.links : [];
    const nasaId = data.nasa_id || item.href || data.title || '';
    const nasaUrl = nasaId ? `https://images.nasa.gov/details/${encodeURIComponent(nasaId)}` : 'https://images.nasa.gov/';

    return {
      data,
      links,
      nasaId,
      nasaUrl,
      raw: item
    };
  });
}

async function fetchTopNasaImages() {
  const allItems = [];

  for (const query of NASA_IMAGE_QUERIES) {
    try {
      const items = await fetchNasaImageQuery(query);
      allItems.push(...items);
      await sleep(800);
    } catch (error) {
      console.error(`Failed to fetch NASA image query "${query}":`, error.message);
    }
  }

  const deduped = dedupeByKey(allItems, (item) => item.nasaId);

  const scored = deduped
    .map((item) => ({
      ...item,
      score: scoreNasaImageItem(item)
    }))
    .filter((item) => item.score >= 12);

  scored.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }

    const aDate = parseDateToMs(a.data.date_created) || 0;
    const bDate = parseDateToMs(b.data.date_created) || 0;
    return bDate - aDate;
  });

  return scored.slice(0, MAX_IMAGES_PER_RUN);
}

async function sendNasaLibraryImage(item) {
  const title = item.data.title || 'New Artemis image';
  const imageUrl = item.links.find((link) => normalizeText(link.render) === 'image')?.href || null;
  const caption = buildNasaLibraryCaption(item);

  if (imageUrl && looksLikeDirectImageUrl(imageUrl)) {
    try {
      await sendTelegramPhoto(imageUrl, caption);
      console.log(`Sent NASA library image: ${title} (score ${item.score})`);
      return true;
    } catch (error) {
      console.error(`NASA library photo send failed for "${title}", falling back to text:`, error.message);
    }
  }

  await sendTelegramMessage(caption);
  console.log(`Sent NASA library text update: ${title} (score ${item.score})`);
  return true;
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

async function processNasaLibrary(sentItems) {
  console.log('Checking NASA image library...');

  const topImages = await fetchTopNasaImages();
  let sentNow = 0;

  for (const item of topImages) {
    const uniqueId = `img:${item.nasaId}`;

    if (!uniqueId || sentItems.has(uniqueId)) {
      continue;
    }

    try {
      await sendNasaLibraryImage(item);
      sentItems.add(uniqueId);
      sentNow += 1;
      await sleep(1200);
    } catch (error) {
      console.error(`Failed to send NASA library item "${item.data.title || 'Untitled'}":`, error.message);
    }
  }

  return sentNow;
}

async function run() {
  const sentItems = loadSentItems();

  let rssCount = 0;
  let imageCount = 0;

  try {
    rssCount = await processRss(sentItems);
  } catch (error) {
    console.error('RSS processing error:', error.message);
  }

  try {
    imageCount = await processNasaLibrary(sentItems);
  } catch (error) {
    console.error('NASA image library processing error:', error.message);
  }

  saveSentItems(sentItems);
  console.log(`Done. Sent ${rssCount} RSS update(s) and ${imageCount} image update(s).`);
}

run().catch((error) => {
  console.error('Fatal error:', error.message);
  process.exit(1);
});