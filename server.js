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

app.post('/api/extract', async (req, res) => {
  const { pageUrl } = req.body;
  if (!pageUrl) return res.status(400).json({ error: 'URL প্রয়োজন' });

  try {
    const response = await axios.get(pageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    const html = response.data;
    let directStreamUrl = null;

    const m3u8Match = html.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/i);
    const mp4Match = html.match(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/i);

    if (m3u8Match) directStreamUrl = m3u8Match[0];
    else if (mp4Match) directStreamUrl = mp4Match[0];
    else {
      const $ = cheerio.load(html);
      directStreamUrl = $('video source').attr('src') || $('video').attr('src');
    }

    if (!directStreamUrl) {
      return res.status(404).json({ error: 'ভিডিও স্ট্রিম পাওয়া যায়নি!' });
    }

    const host = req.get('host');
    const protocol = req.protocol;
    const maskedStreamLink = `${protocol}://${host}/api/stream?source=${Buffer.from(directStreamUrl).toString('base64')}`;

    res.json({ success: true, newStreamLink: maskedStreamLink });
  } catch (error) {
    res.status(500).json({ error: 'ব্যর্থ হয়েছে: ' + error.message });
  }
});

app.get('/api/stream', async (req, res) => {
  const { source } = req.query;
  if (!source) return res.status(400).send('Source missing');

  try {
    const rawUrl = Buffer.from(source, 'base64').toString('ascii');
    const streamResponse = await axios({
      method: 'get',
      url: rawUrl,
      responseType: 'stream',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    });
    res.set(streamResponse.headers);
    streamResponse.data.pipe(res);
  } catch (err) {
    res.status(500).send('Error streaming video');
  }
});

app.listen(PORT, () => console.log('Server running on port ' + PORT));
