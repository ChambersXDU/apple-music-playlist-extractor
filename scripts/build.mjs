import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'apple-music-playlist-extractor.user.js');
const old = existsSync(output) ? readFileSync(output, 'utf8').match(/@version\s+(\S+)/)?.[1] : null;
const stamp = Number(process.env.BUILD_VERSION_TIMESTAMP || Math.floor(Date.now() / 1000));
if (!Number.isSafeInteger(stamp) || stamp <= 0) throw new Error('Invalid build timestamp');
const previous = Number(old?.split('.')[2] || 0);
const version = process.env.BUMP_VERSION === '1'
  ? `3.0.${Math.max(stamp, previous + 1)}`
  : old || `3.0.${stamp}`;
const repository = process.env.GITHUB_REPOSITORY || 'ChambersXDU/apple-music-playlist-extractor';
if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid repository');
const home = `https://github.com/${repository}`;
const raw = `https://raw.githubusercontent.com/${repository}/main/apple-music-playlist-extractor`;
// Keep the original name and namespace so installing over v2.1 replaces it.
const metadata = `// ==UserScript==
// @name         Apple Music 歌单歌曲提取器
// @namespace    http://tampermonkey.net/
// @version      ${version}
// @description  提取 Apple Music 歌单，支持完整加载、复制和 CSV/JSON 下载
// @author       ChambersXDU
// @match        https://music.apple.com/*
// @grant        GM_setClipboard
// @grant        GM_info
// @run-at       document-idle
// @noframes
// @homepageURL  ${home}
// @supportURL   ${home}/issues
// @updateURL    ${raw}.meta.js
// @downloadURL  ${raw}.user.js
// ==/UserScript==
`;
writeFileSync(output, `${metadata}\n${readFileSync(resolve(root, 'src/extractor.js'), 'utf8')}`);
writeFileSync(resolve(root, 'apple-music-playlist-extractor.meta.js'), metadata);
console.log(`Built ${version} for ${repository}`);
