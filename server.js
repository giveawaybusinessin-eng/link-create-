const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// কমন হেডার যা দিয়ে মুভি সাইটগুলোকে বাইপাস করা যায়
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
};

// ডিপ স্ক্র্যাপার এপিআই
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

    let streamType = null;
    let finalSource = null;

    // ১. সরাসরি m3u8 বা mp4 স্ট্রিমিং লিঙ্ক আছে কি না খোঁজা
    const m3u8Match = html.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/i);
    const mp4Match = html.match(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/i);

    if (m3u8Match) {
      finalSource = m3u8Match[0].replace(/\\/g, '');
      streamType = 'direct';
    } else if (mp4Match) {
      finalSource = mp4Match[0].replace(/\\/g, '');
      streamType = 'direct';
    } else {
      // ২. পেজের ভেতর হিডেন আইফ্রেম (iFrame) প্লেয়ার খোঁজা (যেমন: moviesbazar বা মুভিবক্সে থাকে)
      let iframeSrc = $('iframe').attr('src');

      if (!iframeSrc) {
        // স্ক্রিপ্টের ভেতরের এম্বেড লিংক খোঁজা
        const embedMatch = html.match(/https?:\/\/[^\s"'<>]+\/(?:embed|e|v)\/[^\s"'<>]+/i);
        if (embedMatch) iframeSrc = embedMatch[0];
      }

      if (iframeSrc) {
        // রিলেটিভ ইউআরএল হ্যান্ডেল করা
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
      return res.status(404).json({
        error: 'ভিডিও সার্ভার পাওয়া যায়নি। লিংকটি প্রাইভেট বা সুরক্ষা যুক্ত।',
      });
    }

    const host = req.get('host');
    const protocol = req.protocol;
    let newStreamLink = '';

    // নতুন ব্র্যান্ডলেস লিঙ্ক তৈরি করা
    if (streamType === 'direct') {
      newStreamLink = `${protocol}://${host}/api/stream?source=${Buffer.from(finalSource).toString('base64')}`;
    } else {
      // ক্লিন অ্যাড-মুক্ত এম্বেড স্ট্রিম লিঙ্ক
      newStreamLink = `${protocol}://${host}/clean-player.html?embed=${encodeURIComponent(finalSource)}`;
    }

    res.json({
      success: true,
      type: streamType,
      newStreamLink: newStreamLink,
    });
  } catch (err) {
    res.status(500).json({ error: 'সার্ভার সমস্যা: ' + err.message });
  }
});

// ডিরেক্ট স্ট্রিম প্রক্সি
app.get('/api/stream', async (req, res) => {
  const { source } = req.query;
  if (!source) return res.status(400).send('Source missing');

  try {
    const rawUrl = Buffer.from(source, 'base64').toString('ascii');
    const streamRes = await axios({
      method: 'get',
      url: rawUrl,
      responseType: 'stream',
      headers: { 'User-Agent': BROWSER_HEADERS['User-Agent'] },
    });
    res.set(streamRes.headers);
    streamRes.data.pipe(res);
  } catch (err) {
    res.status(500).send('স্ট্রিম লোড হতে সমস্যা হয়েছে');
  }
});

app.listen(PORT, () => console.log('Server running on port ' + PORT));
