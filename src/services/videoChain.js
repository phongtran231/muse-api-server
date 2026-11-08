'use strict';

/**
 * Long videos from short upstream clips. The upstream renders at most 10 s per
 * request, so a longer video is rendered as consecutive parts: each part starts
 * from the last frame of the previous one, and the parts are joined into one
 * H.264/AAC MP4 of exactly the requested length (see dispatcher._renderChained).
 * Needs ffmpeg / ffprobe on the PATH (installed in the Docker image).
 */

const { execFile } = require('child_process');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MAX_PART_SECONDS = 10;
const MIN_PART_SECONDS = 3;

/** Splits `totalSec` into near-equal parts of at most 10 s (each at least 3 s). */
function planParts(totalSec) {
  const total = Math.max(MIN_PART_SECONDS, Math.round(Number(totalSec) || 0));
  const count = Math.ceil(total / MAX_PART_SECONDS);
  const base = Math.floor(total / count);
  const parts = Array.from({ length: count }, (_, i) => base + (i < total % count ? 1 : 0));
  return parts;
}

function run(cmd, args, { timeoutMs = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.message = `${cmd} failed: ${String(stderr || err.message).trim().split('\n').slice(-3).join(' | ')}`;
        return reject(err);
      }
      return resolve(String(stdout));
    });
  });
}

async function withTempDir(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `chain-${crypto.randomBytes(4).toString('hex')}-`));
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function probe(file) {
  const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', file], { timeoutMs: 60000 });
  const info = JSON.parse(out);
  const video = (info.streams || []).find((s) => s.codec_type === 'video') || {};
  return {
    duration: Number(info.format?.duration) || 0,
    width: video.width || 0,
    height: video.height || 0,
    hasAudio: (info.streams || []).some((s) => s.codec_type === 'audio')
  };
}

/** Last frame of an MP4 as a JPEG buffer (the opening frame of the next part). */
async function lastFrame(videoBuffer) {
  return withTempDir(async (dir) => {
    const input = path.join(dir, 'in.mp4');
    const output = path.join(dir, 'last.jpg');
    await fsp.writeFile(input, videoBuffer);
    await run('ffmpeg', ['-y', '-v', 'error', '-sseof', '-0.25', '-i', input, '-update', '1', '-q:v', '2', output]);
    return fsp.readFile(output);
  });
}

/**
 * Joins MP4 parts into one H.264/AAC MP4 cut to exactly `totalSec`. Parts are
 * re-encoded to the first part's size at 24 fps; a part without audio gets
 * silence so the audio track stays continuous.
 */
async function concatParts(buffers, totalSec) {
  return withTempDir(async (dir) => {
    const files = [];
    for (let i = 0; i < buffers.length; i += 1) {
      const file = path.join(dir, `part${i}.mp4`);
      await fsp.writeFile(file, buffers[i]);
      files.push(file);
    }
    const first = await probe(files[0]);
    const width = first.width || 720;
    const height = first.height || 1280;
    const normalized = [];
    for (let i = 0; i < files.length; i += 1) {
      const info = i === 0 ? first : await probe(files[i]);
      const out = path.join(dir, `norm${i}.mp4`);
      const args = ['-y', '-v', 'error', '-i', files[i]];
      if (!info.hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
      args.push(
        '-map', '0:v:0', '-map', info.hasAudio ? '0:a:0' : '1:a:0', '-shortest',
        '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=24,format=yuv420p`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
        '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '160k',
        out
      );
      await run('ffmpeg', args);
      normalized.push(out);
    }
    const list = path.join(dir, 'list.txt');
    await fsp.writeFile(list, normalized.map((f) => `file '${f}'`).join('\n'));
    const output = path.join(dir, 'joined.mp4');
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-t', String(totalSec), '-c', 'copy', '-movflags', '+faststart', output]);
    return fsp.readFile(output);
  });
}

module.exports = { planParts, lastFrame, concatParts, probe, MAX_PART_SECONDS };
