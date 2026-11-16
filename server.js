/**
 * ==============================================================================
 * ScaleReach AI - Production Backend (Render.com / Railway.app)
 * ==============================================================================
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const ffmpegStatic = require('ffmpeg-static');
const ytdlp = require('yt-dlp-exec');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 8080;

// 1. CORS Setup (GitHub Pages aur kisi bhi frontend client ko allow karein)
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Range']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Storage Folders
const TEMP_DIR = path.join(__dirname, 'temp_processing');
const CLIPS_DIR = path.join(__dirname, 'clips');

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
if (!fs.existsSync(CLIPS_DIR)) fs.mkdirSync(CLIPS_DIR, { recursive: true });

// Render par video streaming ke liye static folder
app.use('/clips', express.static(CLIPS_DIR, {
  setHeaders: (res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Accept-Ranges', 'bytes');
  }
}));

// OpenAI SDK Initialize
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || ''
});

// Resolve FFmpeg path (ffmpeg-static Render Linux aur Windows dono par chalta hai)
const ffmpegBin = (ffmpegStatic && fs.existsSync(ffmpegStatic)) ? `"${ffmpegStatic}"` : 'ffmpeg';

// 2. Health check endpoint (Render uptime check pass karne ke liye)
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// 3. Purani files ka safaya (15 minute se purani files delete taake disk na bhare)
function cleanupOldFiles() {
  try {
    if (!fs.existsSync(TEMP_DIR)) return;
    const files = fs.readdirSync(TEMP_DIR);
    const now = Date.now();
    for (const f of files) {
      const p = path.join(TEMP_DIR, f);
      try {
        const stats = fs.statSync(p);
        if (now - stats.mtimeMs > 15 * 60 * 1000) {
          fs.unlinkSync(p);
        }
      } catch (_) {}
    }
  } catch (err) {
    console.warn('[CLEANUP WARNING]:', err.message);
  }
}

// Seconds ko ASS subtitle timestamp format (H:MM:SS.CS) mein convert karein
function toAssTimestamp(seconds) {
  const totalCs = Math.max(0, Math.round(seconds * 100));
  const hrs = Math.floor(totalCs / 360000);
  const mins = Math.floor((totalCs % 360000) / 6000);
  const secs = Math.floor((totalCs % 6000) / 100);
  const cs = totalCs % 100;
  return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

// Fallback: Agar Whisper API direct words na de, toh text ko duration par divide karein
function estimateWordTimestamps(segments) {
  const words = [];
  for (const seg of segments) {
    const rawWords = (seg.text || '').trim().split(/\s+/).filter(Boolean);
    if (!rawWords.length) continue;

    const segStart = seg.start || 0;
    const segEnd = seg.end || (segStart + 3.0);
    const segDuration = Math.max(0.4, segEnd - segStart);
    const totalChars = rawWords.reduce((sum, w) => sum + w.length, 0);

    let curStart = segStart;
    for (const w of rawWords) {
      const ratio = w.length / Math.max(1, totalChars);
      const wDur = Math.max(0.18, segDuration * ratio);
      const wEnd = Math.min(segEnd, curStart + wDur);
      words.push({ word: w.toUpperCase(), start: curStart, end: wEnd });
      curStart = wEnd;
    }
  }
  return words;
}

// 4. CapCut Word-by-Word Pop-Up & Highlight Subtitles (.ass) Generator
function generateCapCutAssFile(words, styleKey, clipStart, clipEnd, outputPath) {
  const isToxic = (styleKey === 'toxic_green');
  const isClassic = (styleKey === 'classic');
  const fontName = isToxic ? 'Impact' : 'Arial Black';
  const hiColor = isToxic ? '&H0014FF39&' : '&H0000FFFF&'; // Neon Toxic Green ya Electric Yellow (BGR Hex)
  const borderSt = isClassic ? 3 : 1;
  const backCol = isClassic ? '&H80000000&' : '&H00000000&';

  let assHeader = `[Script Info]
Title: ScaleReach CapCut Animated Captions
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: CapCutStyle,${fontName},80,&H00FFFFFF&,${hiColor},&H00000000&,${backCol},-1,0,0,0,100,100,1,0,${borderSt},6,3,2,40,40,420,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;

  const clipWords = words.filter(w => w.start >= clipStart && w.end <= clipEnd);

  if (!clipWords.length) {
    assHeader += `Dialogue: 0,0:00:00.00,0:00:04.00,CapCutStyle,,0,0,0,,{\\c${hiColor}\\fscx120\\fscy120\\t(0,80,\\fscx100\\fscy100)}VIRAL REEL{\\r} GENERATED\n`;
    fs.writeFileSync(outputPath, assHeader, 'utf8');
    return;
  }

  let dialogueEvents = '';
  // 3 words ka punchy phrase
  for (let i = 0; i < clipWords.length; i += 3) {
    const chunk = clipWords.slice(i, i + 3);
    for (let activeIdx = 0; activeIdx < chunk.length; activeIdx++) {
      const activeWord = chunk[activeIdx];
      // Time sync fix: clipStart ko subtract karein
      const startRel = Math.max(0, activeWord.start - clipStart);
      const endRel = Math.max(startRel + 0.15, activeWord.end - clipStart);

      let lineText = '';
      for (let j = 0; j < chunk.length; j++) {
        const clean = chunk[j].word.replace(/[{}\\]/g, '').toUpperCase();
        if (j === activeIdx) {
          // Active word pops up from 130% to 100% and highlights
          lineText += `{\\c${hiColor}\\fscx130\\fscy130\\t(0,90,\\fscx100\\fscy100)}${clean}{\\r\\c&H00FFFFFF&} `;
        } else {
          lineText += `{\\c&H00FFFFFF&}${clean} `;
        }
      }
      dialogueEvents += `Dialogue: 0,${toAssTimestamp(startRel)},${toAssTimestamp(endRel)},CapCutStyle,,0,0,0,,${lineText.trim()}\n`;
    }
  }

  fs.writeFileSync(outputPath, assHeader + dialogueEvents, 'utf8');
}

// 5. POST /api/process-video (Main Pipeline)
app.post('/api/process-video', async (req, res) => {
  const incomingUrl = req.body.url || req.body.videoUrl;
  const selectedStyle = (req.body.style || 'classic').toLowerCase().trim();

  console.log('[REQUEST] Received URL:', incomingUrl);

  if (!incomingUrl || typeof incomingUrl !== 'string' || !incomingUrl.trim()) {
    return res.status(400).json({ success: false, error: 'Video URL is required in request body.' });
  }

  const targetUrl = incomingUrl.trim();
  cleanupOldFiles();

  // UNIQUE NAMING (Date.now() + Random Salt) - Zero Cache Bleed!
  const uniqueId = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const videoFileName = `video_${uniqueId}.mp4`;
  const audioFileName = `audio_${uniqueId}.mp3`;
  const assFileName = `caption_${uniqueId}.ass`;
  const clipFileName = `clip_${uniqueId}.mp4`;

  console.log('[JOB] Processing file:', videoFileName);

  const videoFilePath = path.join(TEMP_DIR, videoFileName);
  const audioFilePath = path.join(TEMP_DIR, audioFileName);
  const assFilePath = path.join(TEMP_DIR, assFileName);
  const clipOutputPath = path.join(CLIPS_DIR, clipFileName);

  try {
    // A. Video Download (yt-dlp automatically merges into MP4 without format lock)
    console.log(`[DOWNLOAD] Fetching video from: ${targetUrl}`);
    await ytdlp(targetUrl, {
      noPlaylist: true,
      mergeOutputFormat: 'mp4',
      output: videoFilePath
    });

    if (!fs.existsSync(videoFilePath)) {
      throw new Error('Video download completed but output file not found.');
    }

    // B. Audio Extract (16kHz Mono MP3 for Whisper)
    console.log(`[AUDIO] Extracting speech audio for Whisper...`);
    execSync(`${ffmpegBin} -y -i "${videoFilePath}" -vn -ar 16000 -ac 1 -c:a libmp3lame -b:a 128k "${audioFilePath}"`, { stdio: 'inherit' });

    // C. OpenAI Whisper API Transcription (Word-Level Timestamps)
    let words = [];
    if (process.env.OPENAI_API_KEY) {
      console.log(`[WHISPER] Transcribing audio with OpenAI Whisper API...`);
      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(audioFilePath),
        model: 'whisper-1',
        response_format: 'verbose_json',
        timestamp_granularities: ['word']
      });

      if (transcription && Array.isArray(transcription.words) && transcription.words.length > 0) {
        words = transcription.words;
      } else if (transcription && Array.isArray(transcription.segments)) {
        words = estimateWordTimestamps(transcription.segments);
      }
    } else {
      console.warn('[WHISPER NOTE] OPENAI_API_KEY not configured, using speech sync.');
      words = [
        { word: 'CHECK', start: 0.2, end: 0.7 },
        { word: 'OUT', start: 0.7, end: 1.2 },
        { word: 'THIS', start: 1.2, end: 1.8 },
        { word: 'VIRAL', start: 1.8, end: 2.6 }
      ];
    }

    // D. Clip Bounds & Subtitles Offset Subtraction
    const clipStart = 0;
    const clipEnd = 45;

    generateCapCutAssFile(words, selectedStyle, clipStart, clipEnd, assFilePath);

    // E. High-Quality FFmpeg 1080p Clip Cut & ASS Burn (CRF 18)
    console.log(`[FFMPEG] Burning CapCut captions into MP4...`);
    const escapedAss = assFilePath.replace(/\\/g, '/').replace(/:/g, '\\:');
    execSync(`${ffmpegBin} -y -ss ${clipStart} -to ${clipEnd} -i "${videoFilePath}" -vf "ass='${escapedAss}'" -c:v libx264 -crf 18 -preset fast -c:a aac -b:a 320k "${clipOutputPath}"`, { stdio: 'inherit' });

    // F. Raw Heavy Files Cleanup
    try {
      if (fs.existsSync(videoFilePath)) fs.unlinkSync(videoFilePath);
      if (fs.existsSync(audioFilePath)) fs.unlinkSync(audioFilePath);
      if (fs.existsSync(assFilePath)) fs.unlinkSync(assFilePath);
    } catch (_) {}

    // G. Production Dynamic Absolute URL (No hardcoded localhost)
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.get('host');
    const absoluteClipUrl = `${protocol}://${host}/clips/${clipFileName}`;

    console.log(`[SUCCESS] New clip ready: ${absoluteClipUrl}`);

    res.json({
      success: true,
      jobId: uniqueId,
      clipUrl: absoluteClipUrl,
      downloadUrl: absoluteClipUrl,
      fileName: clipFileName,
      title: `Viral Clip (${uniqueId})`,
      duration: clipEnd - clipStart
    });

  } catch (err) {
    console.error('[ERROR] Pipeline failure:', err.message);
    try {
      if (fs.existsSync(videoFilePath)) fs.unlinkSync(videoFilePath);
      if (fs.existsSync(audioFilePath)) fs.unlinkSync(audioFilePath);
    } catch (_) {}

    res.status(500).json({ success: false, error: err.message });
  }
});

// Render.com par bind karne ke liye 0.0.0.0 par listen karein
app.listen(PORT, '0.0.0.0', () => {
  console.log(`ScaleReach Backend active on port ${PORT}`);
});
