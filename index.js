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
const FLICKR_ALBUM_URL = 'https://www.flickr.com/photos/nasa2explore/albums/72177720307234654/';
const SENT_FILE = 'sent.json';
const MAX_FLICKR_IMAGES_PER_RUN = 4;

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

function scoreFlickrTitle(title) {
  const text = normalizeLower(title);
  let score = 0;

  if (text.includes('artemis ii')) score += 15;
  if (text.includes('artemis')) score += 8;
  if (text.includes('orion')) score += 7;
  if (text.includes('moon')) score += 6;
  if (text.includes('earth')) score += 6;
  if (text.includes('crew')) score += 5;
  if (text.includes('astronaut')) score += 5;
  if (text.includes('window')) score += 3;
  if (text.includes('selfie')) score += 3;
  if (text.includes('flight day')) score += 4;
  if (text.includes('hello')) score += 2;

  if (text.includes('flight director')) score -= 5;
  if (text.includes('mission control')) score -= 4;
  if (text.includes('console')) score -= 4;
  if (text.includes('lead flight director')) score -= 4;
  if (text.includes('launch pad')) score -= 3;

  return score;
}

function parseFlickrAlbumEntries(html) {
  const lines = html.split('\n');
  const entries = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = line.match(/【(\d+)†([^】]*)】/);

    if (!match) {
      continue;
    }

    const linkText = decodeHtmlEntities(match[2] || '').trim();

    if (!linkText || linkText === 'Image') {
      continue;
    }

    const nextLine = lines[i + 1] || '';
    const imageMarker = nextLine.includes('Image†www.flickr.com') || line.includes('Image†www.flickr.com');

    if (!imageMarker && !(lines[i - 1] || '').includes('Image†www.flickr.com')) {
      continue;
    }

    entries.push({
      title: linkText,
      flickrPageUrl: `https://www.flickr.com/photos/nasa2explore/`,
      albumUrl: FLICKR_ALBUM_URL
    });
  }

  return uniqueBy(entries, (entry) => entry.title);
}

async function fetchFlickrPhotoSearchPage(title) {
  const query = encodeURIComponent(`site:flickr.com/photos/nasa2explore "${title}"`);
  const url = `https://r.jina.ai/http://r.jina.ai/http://www.google.com/search?q=${query}`;

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'ArtemisTelegramBot/1.0 (+https://github.com/giladi/artemis-bot)'
      }
    });

    if (!response.ok) {
      return null;
    }

    return response.text();
  } catch {
    return null;
  }
}

async function getFlickrPhotoDetails(title) {
  const searchHtml = await fetchFlickrPhotoSearchPage(title);

  if (!searchHtml) {
    return null;
  }

  const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const titleRegex = new RegExp(`https:\\/\\/www\\.flickr\\.com\\/photos\\/nasa2explore\\/[^\\s\\]]+.*${escapedTitle}`, 'i');
  const urlMatch = searchHtml.match(titleRegex);

  let photoPageUrl = null;

  if (urlMatch && urlMatch[0]) {
    const raw = urlMatch[0];
    const urlOnly = raw.match(/https:\/\/www\.flickr\.com\/photos\/nasa2explore\/[^\s\]]+/i);
    if (urlOnly && urlOnly[0]) {
      photoPageUrl = urlOnly[0].replace(/[),.;]+$/, '');
    }
  }

  if (!photoPageUrl) {
    return null;
  }

  try {
    const photoHtml = await fetchText(photoPageUrl);

    const ogImageMatch =
      photoHtml.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i) ||
      photoHtml.match(/<meta\s+content="([^"]+)"\s+property="og:image"/i);

    const ogTitleMatch =
      photoHtml.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i) ||
      photoHtml.match(/<meta\s+content="([^"]+)"\s+property="og:title"/i);

    const imageUrl = ogImageMatch ? decodeHtmlEntities(ogImageMatch[1]) : null;
    const resolvedTitle = ogTitleMatch ? decodeHtmlEntities(ogTitleMatch[1]) : title;

    return {
      title: resolvedTitle || title,
      photoPageUrl,
      imageUrl
    };
  } catch (error) {
    console.error(`Failed to fetch Flickr photo details for "${title}":`, error.message);
    return null;
  }
}

async function fetchTopFlickrImages() {
  console.log('Checking official Artemis II Flickr album...');

  let albumHtml;
  try {
    albumHtml = await fetchText(FLICKR_ALBUM_URL);
  } catch (error) {
    console.error('Failed to fetch Flickr album page:', error.message);
    return [];
  }

  const albumEntries = parseFlickrAlbumEntries(albumHtml);

  if (albumEntries.length === 0) {
    console.log('No Flickr album entries found.');
    return [];
  }

  const sortedCandidates = [...albumEntries].sort((a, b) => scoreFlickrTitle(b.title) - scoreFlickrTitle(a.title));
  const topCandidates = sortedCandidates.slice(0, 12);

  const results = [];

  for (const candidate of topCandidates) {
    const details = await getFlickrPhotoDetails(candidate.title);

    if (details && details.imageUrl && looksLikeDirectImageUrl(details.imageUrl)) {
      results.push({
        title: details.title,
        photoPageUrl: details.photoPageUrl,
        imageUrl: details.imageUrl,
        score: scoreFlickrTitle(details.title)
      });
    }

    await sleep(1200);
  }

  const deduped = uniqueBy(results, (item) => item.photoPageUrl);

  deduped.sort((a, b) => b.score - a.score);

  return deduped.slice(0, MAX_FLICKR_IMAGES_PER_RUN);
}

async function sendFlickrImage(item) {
  const caption = `📸 ${item.title}\n\n${item.photoPageUrl}`;

  try {
    await sendTelegramPhoto(item.imageUrl, caption);
    console.log(`Sent Flickr image: ${item.title}`);
    return;
  } catch (error) {
    console.error(`Flickr photo send failed for "${item.title}", falling back to text:`, error.message);
  }

  await sendTelegramMessage(caption);
  console.log(`Sent Flickr text update: ${item.title}`);
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

async function processFlickr(sentItems) {
  const images = await fetchTopFlickrImages();
  let sentNow = 0;

  for (const item of images) {
    const uniqueId = `flickr:${item.photoPageUrl}`;

    if (!uniqueId || sentItems.has(uniqueId)) {
      continue;
    }

    try {
      await sendFlickrImage(item);
      sentItems.add(uniqueId);
      sentNow += 1;
      await sleep(1200);
    } catch (error) {
      console.error(`Failed to send Flickr item "${item.title}":`, error.message);
    }
  }

  return sentNow;
}

async function run() {
  const sentItems = loadSentItems();

  let rssCount = 0;
  let flickrCount = 0;

  try {
    rssCount = await processRss(sentItems);
  } catch (error) {
    console.error('RSS processing error:', error.message);
  }

  try {
    flickrCount = await processFlickr(sentItems);
  } catch (error) {
    console.error('Flickr processing error:', error.message);
  }

  saveSentItems(sentItems);
  console.log(`Done. Sent ${rssCount} RSS update(s) and ${flickrCount} Flickr image update(s).`);
}

run().catch((error) => {
  console.error('Fatal error:', error.message);
  process.exit(1);
});