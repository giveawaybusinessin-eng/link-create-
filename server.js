const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.enable('trust proxy');
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': '*/*',
};

// ১. মুভি পেজ থেকে স্ট্রিমিং লিংক বের করা
app.post('/api/extract', async (req, res) => {
  const { pageUrl } = req.body;
  if (!pageUrl) return res.status(400).json({ error: 'URL প্রদান করুন' });

  try {
    const response = await axios.get(pageUrl, {
      headers: { ...BROWSER_HEADERS, 'Referer': pageUrl },
      timeout: 10000,
    });

    const html = response.data;
    const $ = cheerio.load(html);

    let streamType = 'hls';
    let finalSource = null;

    // m3u8 বা mp4 লিংক বের করা
    const m3u8Match = html.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/i);
    const mp4Match = html.match(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/i);

    if (m3u8Match) {
      finalSource = m3u8Match[0].replace(/\\/g, '');
      streamType = 'hls';
    } else if (mp4Match) {
      finalSource = mp4Match[0].replace(/\\/g, '');
      streamType = 'mp4';
    } else {
      let iframeSrc = $('iframe').attr('src');
      if (!iframeSrc) {
        const embedMatch = html.match(/https?:\/\/[^\s"'<>]+\/(?:embed|e|v)\/[^\s"'<>]+/i);
        if (embedMatch) iframeSrc = embedMatch[0];
      }

      if (iframeSrc) {
        if (iframeSrc.startsWith('//')) iframeSrc = 'https:' + iframeSrc;
        else if (iframeSrc.startsWith('/')) {
          const urlObj = new URL(pageUrl);
          iframeSrc = urlObj.origin + iframeSrc;
        }
        finalSource = iframeSrc;
        streamType = 'embed';
      }
    }

    if (!finalSource) {
      return res.status(404).json({ error: 'ভিডিও পাওয়া যায়নি! লিংকটি প্রাইভেট বা সিকিউরড।' });
    }

    // অলওয়েজ HTTPS নিশ্চিত করা (Render-এর জন্য)
    const host = req.get('host');
    const sourceBase64 = encodeURIComponent(Buffer.from(finalSource).toString('base64'));
    
    // যেকোনো জায়গায় শেয়ার করার মতো আল্ট্রা-ক্লিন ওয়াচ লিংক
    const shareableWatchUrl = `https://${host}/watch?src=${sourceBase64}&type=${streamType}`;

    res.json({
      success: true,
      type: streamType,
      newStreamLink: shareableWatchUrl,
      rawProxyUrl: `https://${host}/api/stream?source=${sourceBase64}`
    });
  } catch (err) {
    res.status(500).json({ error: 'ব্যর্থ হয়েছে: ' + err.message });
  }
});

// ২. যেকোনো ব্রাউজারে পেস্ট করলেই যে সিনেমা পেজে সরাসরি ভিডিও চলবে (/watch)
app.get('/watch', (req, res) => {
  const { src, type } = req.query;
  if (!src) return res.send('ভিডিও লিংক খুঁজে পাওয়া যায়নি!');

  let rawSource = '';
  try {
    rawSource = Buffer.from(decodeURIComponent(src), 'base64').toString('utf-8');
  } catch (e) {
    return res.send('ভুল ভিডিও লিংক!');
  }

  const isEmbed = type === 'embed';
  const streamSrc = isEmbed ? rawSource : `/api/stream?source=${src}`;

  // ডেডিকেটেড ডার্ক সিনেমা প্লেয়ার পেজ
  res.send(`
    <!DOCTYPE html>
    <html lang="bn">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
      <title>Private Cinema Player</title>
      <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
      <style>
        * { margin:0; padding:0; box-sizing:border-box; background:#000; color:#fff; }
        body, html { width:100%; height:100%; overflow:hidden; display:flex; align-items:center; justify-content:center; }
        .player-wrap { position:relative; width:100%; height:100%; display:flex; align-items:center; justify-content:center; }
        video, iframe { width:100%; height:100%; border:none; outline:none; }
      </style>
    </head>
    <body>
      <div class="player-wrap">
        ${
          isEmbed
            ? `<iframe src="${streamSrc}" sandbox="allow-scripts allow-same-origin allow-forms" allow="autoplay; fullscreen"></iframe>`
            : `<video id="videoPlayer" controls autoplay playsinline></video>`
        }
      </div>
      <script>
        const video = document.getElementById('videoPlayer');
        if (video) {
          const streamUrl = "${streamSrc}";
          if (Hls.isSupported()) {
            const hls = new Hls({ enableWorker: true });
            hls.loadSource(streamUrl);
            hls.attachMedia(video);
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
              video.play().catch(() => { video.muted = true; video.play(); });
            });
          } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = streamUrl;
            video.play();
          } else {
            video.src = streamUrl;
            video.play();
          }
        }
      </script>
    </body>
    </html>
  `);
});

// ৩. স্মার্ট HLS প্রক্সি ও খণ্ড খণ্ড অংশ (Segments) বাইপাস করা
app.get('/api/stream', async (req, res) => {
  const { source } = req.query;
  if (!source) return res.status(400).send('Source missing');

  try {
    const rawUrl = Buffer.from(decodeURIComponent(source), 'base64').toString('utf-8');

    const streamRes = await axios({
      method: 'get',
      url: rawUrl,
      responseType: rawUrl.includes('.m3u8') ? 'text' : 'stream',
      headers: {
        'User-Agent': BROWSER_HEADERS['User-Agent'],
        'Referer': rawUrl,
      },
      timeout: 15000,
    });

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');

    // m3u8 হলে ভেতরের সেগমেন্টগুলোকে অটো-রিরাইট করা
    if (typeof streamRes.data === 'string' && streamRes.data.includes('#EXTM3U')) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      const lines = streamRes.data.split('\n');
      const host = req.get('host');

      const rewritten = lines
        .map((line) => {
          let trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) return line;
          try {
            const absUrl = new URL(trimmed, rawUrl).href;
            const b64 = encodeURIComponent(Buffer.from(absUrl).toString('base64'));
            return `https://${host}/api/stream?source=${b64}`;
          } catch (e) {
            return line;
          }
        })
        .join('\n');

      return res.send(rewritten);
    }

    // অন্যান্য TS চunks বা MP4 সরাসরি পাস করা
    res.set(streamRes.headers);
    res.setHeader('Access-Control-Allow-Origin', '*');
    streamRes.data.pipe(res);
  } catch (err) {
    res.status(500).send('স্ট্রিম ত্রুটি: ' + err.message);
  }
});

app.listen(PORT, () => console.log('Server running on port ' + PORT));
