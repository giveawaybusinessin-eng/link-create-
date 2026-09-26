// server.js
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

// মুভিবক্স বা অন্য পেজ থেকে ডিরেক্ট স্ট্রিম বের করার এপিআই
app.post('/api/extract', async (req, res) => {
  const { pageUrl } = req.body;

  if (!pageUrl) {
    return res.status(400).json({ error: 'URL প্রদান করা আবশ্যক!' });
  }

  try {
    // মুভিবক্স পেজে ফেচ রিকোয়েস্ট পাঠানো (রিয়েল ব্রাউজার হেডার সহ)
    const response = await axios.get(pageUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    const html = response.data;
    let directStreamUrl = null;

    // ১. ভিডিও সোর্স বা স্ক্রিপ্ট থেকে .m3u8 বা .mp4 লিংক খোঁজা
    const m3u8Match = html.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/i);
    const mp4Match = html.match(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/i);

    if (m3u8Match) {
      directStreamUrl = m3u8Match[0];
    } else if (mp4Match) {
      directStreamUrl = mp4Match[0];
    } else {
      // চেকের জন্য Cheerio দিয়ে <video> অথবা <source> ট্যাগ স্ক্র্যাপ করা
      const $ = cheerio.load(html);
      directStreamUrl = $('video source').attr('src') || $('video').attr('src');
    }

    if (!directStreamUrl) {
      return res.status(404).json({
        error:
          'সরাসরি ভিডিও স্ট্রিম পাওয়া যায়নি। পেজটি টোকেন বা অ্যাপ-লক করা থাকতে পারে।',
      });
    }

    // মুভিবক্সের নাম নিশানা মুছে দিয়ে সম্পূর্ণ আপনার সার্ভারের নতুন স্ট্রিম লিংক তৈরি করা
    const protocol = req.protocol;
    const host = req.get('host');
    const maskedStreamLink = `${protocol}://${host}/api/stream?source=${encodeURIComponent(
      Buffer.from(directStreamUrl).toString('base64')
    )}`;

    res.json({
      success: true,
      originalExtracted: directStreamUrl,
      newStreamLink: maskedStreamLink, // এই লিংকটির সাথে মুভিবক্সের কোনো প্রকাশ্য যোগসূত্র থাকবে না
    });
  } catch (error) {
    res.status(500).json({
      error: 'ভিডিও লিংক এক্সট্র্যাক্ট করতে ব্যর্থ হয়েছে: ' + error.message,
    });
  }
});

// স্ট্রিম প্রক্সি (মূল সাইটের রেফারার ও ব্লক বাইপাস করার জন্য)
app.get('/api/stream', async (req, res) => {
  const { source } = req.query;
  if (!source) return res.status(400).send('Source missing');

  try {
    const rawUrl = Buffer.from(source, 'base64').toString('ascii');
    
    // থার্ড পার্টি সাইট বাইপাস করে সরাসরি ভিডিও স্ট্রিম রিলে করা
    const streamResponse = await axios({
      method: 'get',
      url: rawUrl,
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
    });

    res.set(streamResponse.headers);
    streamResponse.data.pipe(res);
  } catch (err) {
    res.status(500).send('স্ট্রিমিং রিলে ত্রুটি: ' + err.message);
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
