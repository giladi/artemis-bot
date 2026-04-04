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

        console.warn('Skipping this run because NASA rate-limited the request.');
        return null;
      }

      throw error;
    }
  }

  return null;
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

function isRelevantItem(item) {
  const title = (item.title || '').toLowerCase();
  const content = (item.contentSnippet || item.content || '').toLowerCase();

  return title.includes('artemis') || content.includes('artemis');
}

async function sendItem(title, link, imageUrl) {
  const caption = `🚀 ${title}\n\n${link}`;

  if (imageUrl && looksLikeDirectImageUrl(imageUrl)) {
    try {
      await sendTelegramPhoto(imageUrl, caption);
      console.log(`Sent photo update: ${title}`);
      return;
    } catch (error) {
      console.error(`Photo send failed for "${title}", falling back to text:`, error.message);
    }
  }

  await sendTelegramMessage(caption);
  console.log(`Sent text update: ${title}`);
}

async function run() {
  console.log('Checking NASA RSS feed...');

  const sentItems = loadSentItems();
  const feed = await fetchFeedWithRetry();

  if (!feed) {
    console.log('No feed data available for this run.');
    return;
  }

  const relevantItems = (feed.items || []).filter(isRelevantItem);

  if (relevantItems.length === 0) {
    console.log('No Artemis-related items found.');
    return;
  }

  let sentNow = 0;

  for (const item of relevantItems.reverse()) {
    const uniqueId = item.guid || item.id || item.link || item.title;

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
      await sendItem(title, link, imageUrl);
      sentItems.add(uniqueId);
      sentNow += 1;
    } catch (error) {
      console.error(`Failed to send item "${title}":`, error.message);
    }
  }

  saveSentItems(sentItems);
  console.log(`Done. Sent ${sentNow} new update(s).`);
}

run().catch((error) => {
  console.error('Fatal error:', error.message);
  process.exit(1);
});