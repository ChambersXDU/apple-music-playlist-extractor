(function (factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else api.boot();
})(function () {
    'use strict';

    const ROW_SELECTORS = [
        '[data-testid="track-list-item"]', '[data-testid="tracklist-row"]',
        '.songs-list-row', '[class~="track-list-item"]',
        '[role="row"]', 'li[class*="track"]',
    ];
    const TITLE_SELECTOR = '[data-testid="track-title"], [data-testid="song-name"], '
        + '[class*="song-name"], [class*="track-title"], [class*="trackName"], [class*="item-title"]';
    const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
    const playlistId = url => {
        try { return new URL(url, 'https://music.apple.com').pathname.match(/^\/[^/]+\/playlist\/(?:[^/]+\/)?([^/]+)\/?$/)?.[1] || ''; }
        catch { return ''; }
    };

    function songId(url) {
        try {
            const u = new URL(url, 'https://music.apple.com');
            return u.searchParams.get('i') || u.pathname.match(/\/song\/(?:[^/]+\/)?(\d+)\/?$/)?.[1] || '';
        } catch { return ''; }
    }

    function firstText(element) {
        if (!element) return '';
        const walker = element.ownerDocument.createTreeWalker(element, 4);
        let node;
        while ((node = walker.nextNode())) {
            if (clean(node.textContent)) return clean(node.textContent);
        }
        return '';
    }

    function parseRow(row) {
        if (row.querySelector('[role="columnheader"]') || /header/i.test(row.className || '')) return null;
        const songLink = [...row.querySelectorAll('a[href]')].find(a => songId(a.href));
        let name = firstText(row.querySelector(TITLE_SELECTOR)) || clean(songLink?.textContent);
        if (!name) {
            // Do not interpret controls, row numbers or whole aria-labels as titles.
            for (const cell of row.querySelectorAll('[role="cell"], [role="gridcell"], td')) {
                if (cell.querySelector('a[href*="/artist/"], a[href*="/album/"], button')) continue;
                const text = firstText(cell);
                if (text && !/^\d+$|^\d+:\d{2}$/.test(text)) { name = text; break; }
            }
        }
        if (!name) return null;
        const artists = [...row.querySelectorAll('a[href*="/artist/"]')].map(a => clean(a.textContent)).filter(Boolean);
        const albumLink = [...row.querySelectorAll('a[href*="/album/"]')].find(a => !songId(a.href));
        const positionText = clean(row.querySelector('[data-testid="track-number"], [class*="song-number"], [class*="track-number"]')?.textContent);
        const dataRow = row.getAttribute('data-row');
        const position = dataRow != null && /^\d+$/.test(dataRow) ? Number(dataRow) + 1
            : /^\d+$/.test(positionText) ? Number(positionText) : Number(row.getAttribute('aria-rowindex')) || null;
        return {
            name,
            artist: [...new Set(artists)].join('、') || clean(row.querySelector('[data-testid="track-artist"], [class*="song-artist"]')?.textContent),
            album: clean(albumLink?.textContent) || clean(row.querySelector('[data-testid="track-album"], [class*="song-album"]')?.textContent),
            id: songId(songLink?.href), position,
        };
    }

    function findRows(doc) {
        const main = doc.querySelector('main, [role="main"]') || doc.body;
        if (!main) return [];
        const candidates = [...main.querySelectorAll(ROW_SELECTORS.join(','))];
        return candidates.filter(row => !row.querySelector(ROW_SELECTORS.join(',')) && parseRow(row));
    }

    function readEmbedded(doc, url) {
        const id = playlistId(url);
        const empty = { songs: [], expected: null };
        if (!id) return empty;
        try {
            const raw = doc.querySelector('script#serialized-server-data[type="application/json"]')?.textContent;
            if (!raw) return empty;
            const payload = JSON.parse(raw);
            const entry = payload.data?.find(item => item.intent?.contentDescriptor?.kind === 'playlist'
                && item.intent.contentDescriptor.identifiers?.storeAdamID === id);
            if (!entry) return empty;
            const sections = entry.data?.sections || [];
            const header = sections.flatMap(section => section.items || []).find(item => Number.isInteger(item.trackCount));
            const section = sections.find(s => s.itemKind === 'trackLockup' && s.id === `track-list - ${id}`);
            const songs = (section?.items || []).filter(item => ['song', 'musicVideo'].includes(item.contentDescriptor?.kind)).map((item, index) => ({
                name: clean(item.title),
                artist: clean(item.artistName) || (item.subtitleLinks || []).map(link => clean(link.title)).filter(Boolean).join('、'),
                album: (item.tertiaryLinks || []).map(link => clean(link.title)).filter(Boolean).join('、'),
                id: String(item.contentDescriptor.identifiers?.storeAdamID || ''),
                position: index + 1,
            })).filter(song => song.name);
            return { songs, expected: Number.isInteger(header?.trackCount) ? header.trackCount : null };
        } catch { return empty; }
    }

    function createCollector() {
        const entries = new Map();
        return {
            add(song) {
                if (!song?.name) return;
                let key = song.position ? `position:${song.position}` : song.id ? `id:${song.id}`
                    : `text:${JSON.stringify([song.name, song.artist, song.album].map(clean))}`;
                // A title alone never identifies a song. Positions retain intentional repeats.
                if (!song.position && song.id) {
                    const matches = [...entries].filter(([, value]) => value.id === song.id);
                    if (matches.length === 1) key = matches[0][0];
                } else if (song.position && song.id && entries.has(`id:${song.id}`)) {
                    const previous = entries.get(`id:${song.id}`);
                    entries.delete(`id:${song.id}`);
                    entries.set(key, previous);
                }
                const previous = entries.get(key);
                entries.set(key, previous ? {
                    ...previous,
                    ...Object.fromEntries(Object.entries(song).filter(([, value]) => value !== '' && value != null)),
                } : { ...song });
            },
            get size() { return entries.size; },
            values() {
                return [...entries.values()].sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity));
            },
        };
    }

    function expectedCount(doc, url) {
        const footer = doc.querySelector('[data-testid="tracklist-footer-description"], [data-testid="tracklist-footer"]');
        const match = clean(footer?.textContent).match(/^([\d,，.\s]+)\s*(?:首歌曲|首歌|songs?\b|tracks?\b|曲)/i);
        if (match) return Number(match[1].replace(/\D/g, ''));
        const canonical = doc.querySelector('link[rel="canonical"]')?.href;
        if (playlistId(canonical) !== playlistId(url)) return null;
        const count = doc.querySelector('meta[property="music:song_count"]')?.content;
        return count != null && /^\d+$/.test(count) ? Number(count) : null;
    }

    function publicSongs(songs) {
        return songs.map(song => ({ name: song.name, artist: song.artist || '未知歌手', album: song.album || '未知专辑' }));
    }

    function delay(ms, signal) {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) return reject(new DOMException('Scan cancelled', 'AbortError'));
            const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
            const timer = setTimeout(finish, ms);
            const abort = () => {
                clearTimeout(timer);
                signal.removeEventListener('abort', abort);
                reject(new DOMException('Scan cancelled', 'AbortError'));
            };
            signal?.addEventListener('abort', abort, { once: true });
        });
    }

    function findScroller(doc, rows) {
        for (let node = rows[0]?.parentElement; node && node !== doc.body; node = node.parentElement) {
            const overflow = doc.defaultView.getComputedStyle(node).overflowY;
            if (/(auto|scroll)/.test(overflow) && node.scrollHeight > node.clientHeight) return node;
        }
        const candidates = doc.querySelectorAll('main, [role="main"], [class*="scroller"], [class*="main-content"]');
        return [...candidates].find(node => /(auto|scroll)/.test(doc.defaultView.getComputedStyle(node).overflowY)
            && node.scrollHeight > node.clientHeight) || doc.scrollingElement || doc.documentElement;
    }

    async function scan(doc, { signal, onProgress = () => {}, interval = 500, maxDuration = 120000, idleDuration = 3500 } = {}) {
        const url = doc.defaultView.location.href;
        const embedded = readEmbedded(doc, url);
        const collector = createCollector();
        embedded.songs.forEach(song => collector.add(song));
        let expected = embedded.expected ?? expectedCount(doc, url);
        const result = reason => ({ songs: publicSongs(collector.values()), expected, reason,
            complete: expected != null && collector.size >= expected });
        const check = () => {
            if (signal?.aborted || doc.defaultView.location.href !== url) throw new DOMException('Scan cancelled', 'AbortError');
        };
        check();
        if (expected != null && collector.size >= expected) return result('embedded');
        const capture = () => findRows(doc).forEach(row => collector.add(parseRow(row)));
        capture();
        if (expected != null && collector.size >= expected) return result('count');
        // Hydration removes the initial JSON script. Fetch only this same playlist,
        // and parse as an inert document; no page scripts or assets are executed.
        if (typeof doc.defaultView.fetch === 'function') {
            try {
                const fetchSignal = doc.defaultView.AbortSignal.any([
                    ...(signal ? [signal] : []), doc.defaultView.AbortSignal.timeout(8000),
                ]);
                const response = await doc.defaultView.fetch(url, { signal: fetchSignal });
                if (response.ok && playlistId(response.url) === playlistId(url)) {
                    const snapshot = new doc.defaultView.DOMParser().parseFromString(await response.text(), 'text/html');
                    const fresh = readEmbedded(snapshot, url);
                    fresh.songs.forEach(song => collector.add(song));
                    expected = fresh.expected ?? expected;
                }
            } catch (error) {
                if (signal?.aborted) throw error;
            }
            check();
            if (expected != null && collector.size >= expected) return result('embedded');
        }
        let scroller = findScroller(doc, findRows(doc));
        const originalTop = scroller.scrollTop;
        const originalLeft = scroller.scrollLeft;
        const originalBehavior = scroller.style.scrollBehavior;
        const started = Date.now();
        let lastSignature = '', stableSince = started;
        try {
            scroller.style.scrollBehavior = 'auto';
            capture();
            scroller.scrollTop = 0;
            while (Date.now() - started < maxDuration) {
                check();
                capture();
                onProgress(collector.size, expected);
                if (expected != null && collector.size >= expected) return result('count');
                const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
                const atBottom = scroller.scrollTop >= max - 2;
                const signature = `${collector.size}:${scroller.scrollHeight}:${scroller.scrollTop}`;
                if (signature !== lastSignature) { lastSignature = signature; stableSince = Date.now(); }
                if (atBottom && Date.now() - stableSince >= idleDuration
                    && (collector.size > 0 || Date.now() - started >= 10000)) return result('idle');
                if (!atBottom) scroller.scrollTop = Math.min(max, scroller.scrollTop + Math.max(200, scroller.clientHeight * 0.8));
                await delay(interval, signal);
            }
            check();
            capture();
            return result('timeout');
        } finally {
            scroller.style.scrollBehavior = originalBehavior;
            if (doc.defaultView.location.href === url) {
                scroller.scrollTop = originalTop;
                scroller.scrollLeft = originalLeft;
            }
        }
    }

    function csvCell(value) {
        let text = String(value ?? '');
        // Quoting alone does not prevent spreadsheet formula execution.
        if (/^[\s\uFEFF]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
        return `"${text.replace(/"/g, '""')}"`;
    }

    function format(songs, type) {
        if (type === 'json') return JSON.stringify(songs, null, 2);
        if (type === 'csv') return [['序号', '歌名', '歌手', '专辑'], ...songs.map((song, i) => [i + 1, song.name, song.artist, song.album])]
            .map(row => row.map(csvCell).join(',')).join('\r\n');
        if (type === 'table') return ['序号\t歌曲\t歌手\t专辑', ...songs.map((song, i) => [i + 1, song.name, song.artist, song.album]
            .map(value => String(value).replace(/[\t\r\n]+/g, ' ')).join('\t'))].join('\n');
        return songs.map((song, i) => `${i + 1}. ${song.name} - ${song.artist} [${song.album}]`).join('\n');
    }

    function boot() {
        if (document.getElementById('am-extractor-host')) return;
        const host = document.createElement('div');
        host.id = 'am-extractor-host';
        const root = host.attachShadow({ mode: 'open' });
        /*
         * refresh-cw icon: https://lucide.dev/icons/refresh-cw
         * ISC License — Copyright (c) 2026 Lucide Icons and Contributors
         * Permission to use, copy, modify, and/or distribute this software for any
         * purpose with or without fee is hereby granted, provided that the above
         * copyright notice and this permission notice appear in all copies.
         * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
         * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
         * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
         * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
         * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
         * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
         * OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
         */
        const icon = (name, size = 18) => {
            const paths = {
                music: '<path d="M9 18V5l12-2v13M9 8l12-2"/><ellipse cx="6" cy="18" rx="3" ry="2"/><ellipse cx="18" cy="16" rx="3" ry="2"/>',
                copy: '<rect x="8" y="8" width="12" height="12" rx="3"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
                download: '<path d="M12 3v12m-4-4 4 4 4-4M5 16v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3"/>',
                refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
                more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
                close: '<path d="m6 6 12 12M6 18 18 6"/>',
            };
            return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${name === 'refresh' ? 2 : 1.7}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
        };
        root.innerHTML = `
            <style>
                :host {
                    all: initial; color-scheme: light dark;
                    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
                    --text: #1d1d1f; --muted: #62626a; --accent: #d91442; --primary: #d91442; --on-accent: #fff;
                    --solid: #f7f7fa; --glass: rgba(250, 250, 253, .84); --content: rgba(255, 255, 255, .22);
                    --line: rgba(35, 35, 50, .09); --edge: rgba(255, 255, 255, .8); --glint: rgba(255, 255, 255, .55);
                    --control: rgba(80, 80, 100, .065); --hover: rgba(80, 80, 100, .11);
                    --menu: #fbfbfd; --thead: #f0f0f5; --shade: rgba(20, 20, 30, .2);
                    --shadow: 0 24px 80px rgba(0, 0, 0, .18), 0 4px 16px rgba(0, 0, 0, .06);
                    --material: blur(32px) saturate(155%);
                }
                @media (prefers-color-scheme: dark) {
                    :host {
                        --text: #f5f5f7; --muted: #b9b9c2; --accent: #ff375f; --primary: #df1b49;
                        --solid: #252529; --glass: rgba(35, 35, 40, .86); --content: rgba(0, 0, 0, .06);
                        --line: rgba(255, 255, 255, .09); --edge: rgba(255, 255, 255, .18); --glint: rgba(255, 255, 255, .065);
                        --control: rgba(255, 255, 255, .08); --hover: rgba(255, 255, 255, .13);
                        --menu: #303035; --thead: #2b2b30; --shade: rgba(0, 0, 0, .32);
                        --shadow: 0 28px 90px rgba(0, 0, 0, .4), 0 4px 18px rgba(0, 0, 0, .2);
                    }
                }
                * { box-sizing: border-box; }
                [hidden] { display: none !important; }
                button, summary { -webkit-tap-highlight-color: transparent; }
                button {
                    display: inline-flex; align-items: center; justify-content: center; gap: 7px;
                    min-height: 36px; padding: 8px 14px; border: 0; border-radius: 999px;
                    font: inherit; font-size: 13px; font-weight: 500; color: var(--text);
                    background: var(--control); cursor: pointer; white-space: nowrap;
                    transition: background .16s ease, transform .16s ease;
                }
                button:hover, summary:hover { background: var(--hover); }
                button:active:not(:disabled) { transform: scale(.97); }
                button:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
                button:disabled { cursor: default; opacity: .4; }
                button svg { flex: none; }
                #launch, dialog, #notice {
                    background: var(--solid);
                    border: 1px solid var(--edge);
                    box-shadow: var(--shadow), inset 0 1px 0 var(--glint);
                }
                @supports ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
                    #launch, dialog, #notice {
                        background: linear-gradient(145deg, var(--glint), transparent 55%), var(--glass);
                        -webkit-backdrop-filter: var(--material); backdrop-filter: var(--material);
                    }
                }
                #launch {
                    position: fixed; right: 24px; bottom: 100px; z-index: 2147483646;
                    width: 52px; height: 52px; padding: 0; color: var(--accent);
                    box-shadow: 0 8px 28px rgba(0, 0, 0, .16), inset 0 1px 0 var(--glint);
                }
                #launch:hover { transform: translateY(-2px); }
                dialog {
                    width: min(860px, calc(100vw - 40px)); max-height: 84vh; max-height: 84dvh;
                    padding: 0; color: var(--text); border-radius: 26px; overflow: hidden;
                }
                dialog[open] { display: flex; flex-direction: column; animation: appear .2s ease-out; }
                dialog::backdrop { background: var(--shade); }
                @keyframes appear { from { transform: translateY(8px); } to { transform: translateY(0); } }
                header { display: flex; align-items: flex-start; gap: 16px; padding: 25px 28px 19px; flex: none; }
                .heading { flex: 1; min-width: 0; }
                h2 { margin: 0; font-size: 23px; font-weight: 650; letter-spacing: -.6px; line-height: 1.25; }
                #playlist-name { margin: 7px 0 0; font-size: 13px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                #count { margin-top: 3px; padding: 6px 10px; font-size: 12px; font-variant-numeric: tabular-nums; color: var(--muted); background: var(--control); border-radius: 999px; white-space: nowrap; }
                .icon-button, summary { width: 34px; min-height: 34px; padding: 0; flex: none; }
                #close { color: var(--muted); }
                nav { display: flex; align-items: center; gap: 9px; padding: 0 28px 20px; flex: none; }
                .primary { color: var(--on-accent); background: var(--primary); box-shadow: 0 2px 8px rgba(215, 20, 66, .12); }
                .primary:hover { background: var(--primary); filter: brightness(.96); }
                .spacer { flex: 1; }
                #more { position: relative; }
                summary { display: flex; align-items: center; justify-content: center; list-style: none; border-radius: 50%; cursor: pointer; color: var(--muted); transition: background .16s ease; }
                summary::-webkit-details-marker { display: none; }
                #more[open] summary { background: var(--hover); }
                .more-menu {
                    position: absolute; top: calc(100% + 8px); right: 0; z-index: 3;
                    display: grid; gap: 2px; min-width: 172px; padding: 6px;
                    max-height: min(300px, calc(84dvh - 180px)); overflow: auto;
                    background: var(--menu); border: 1px solid var(--line); border-radius: 16px;
                    box-shadow: 0 12px 36px rgba(0, 0, 0, .18);
                }
                .more-menu button { width: 100%; justify-content: flex-start; border-radius: 10px; background: transparent; min-height: 34px; }
                .more-menu button:hover { background: var(--hover); }
                .menu-separator { height: 1px; margin: 4px 8px; background: var(--line); }
                .body { flex: 1; min-height: 0; overflow: auto; background: var(--content); border-top: 1px solid var(--line); scrollbar-width: thin; scrollbar-color: var(--muted) transparent; }
                table { width: 100%; min-width: 540px; table-layout: fixed; border-collapse: separate; border-spacing: 0; text-align: left; font-size: 13px; }
                .index { width: 64px; } .song { width: 40%; } .artist { width: 24%; }
                th { position: sticky; top: 0; z-index: 1; font-size: 11px; font-weight: 500; color: var(--muted); background: var(--thead); }
                th, td { padding: 13px 16px; border-bottom: 1px solid var(--line); }
                th:first-child, td:first-child { padding: 13px 12px; text-align: center; color: var(--muted); font-variant-numeric: tabular-nums; }
                th:last-child, td:last-child { padding-right: 28px; }
                td { height: 47px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); }
                td:first-child { overflow: visible; text-overflow: clip; }
                td:nth-child(2) { color: var(--text); font-weight: 500; }
                tbody tr:last-child td { border-bottom: 0; }
                tbody tr:hover td { background: var(--control); }
                footer { flex: none; padding: 14px 28px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px; line-height: 1.5; }
                #notice { position: fixed; bottom: 35px; left: 50%; transform: translateX(-50%); padding: 12px 20px; border-radius: 999px; color: var(--text); z-index: 2147483647; font-size: 13px; max-width: 90vw; }
                @media (max-width: 600px) {
                    dialog { width: calc(100vw - 24px); border-radius: 22px; }
                    header { padding: 20px 20px 17px; gap: 10px; } h2 { font-size: 21px; }
                    nav { padding: 0 20px 16px; gap: 6px; } nav > button { padding: 8px 11px; }
                    button, .icon-button, summary { min-height: 40px; } .icon-button, summary { width: 40px; }
                    nav > button:not(.icon-button) > svg { display: none; } footer { padding: 12px 20px; }
                }
                @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
                @media (prefers-reduced-transparency: reduce), (prefers-contrast: more) {
                    #launch, dialog, #notice { background: var(--solid); -webkit-backdrop-filter: none; backdrop-filter: none; }
                    .body { background: var(--solid); }
                }
                @media (forced-colors: active) {
                    #launch, dialog, #notice, .more-menu { background: Canvas; color: CanvasText; border: 1px solid CanvasText; box-shadow: none; -webkit-backdrop-filter: none; backdrop-filter: none; }
                    button, summary, #count, td, th, footer, #playlist-name, #close { color: CanvasText; }
                    .primary { background: Highlight; color: HighlightText; } button { border: 1px solid ButtonText; }
                }
            </style>
            <button id="launch" title="提取歌单歌曲" aria-label="提取歌单歌曲" hidden>${icon('music', 24)}</button>
            <dialog aria-labelledby="heading" aria-describedby="playlist-name">
                <header><div class="heading"><h2 id="heading">歌单歌曲</h2><p id="playlist-name">Apple Music</p></div><span id="count"></span><button id="close" class="icon-button" aria-label="关闭">${icon('close', 16)}</button></header>
                <nav aria-label="导出与扫描">
                    <button class="primary" data-copy="table">${icon('copy', 16)}复制表格</button>
                    <button data-download="csv">${icon('download', 16)}导出 CSV</button>
                    <span class="spacer"></span>
                    <button id="rescan" class="icon-button" title="重新扫描" aria-label="重新扫描">${icon('refresh')}</button>
                    <button id="stop" hidden>取消</button>
                    <details id="more"><summary aria-label="更多操作" title="更多操作">${icon('more')}</summary><div class="more-menu">
                        <button data-copy="csv">复制 CSV</button><button data-copy="list">复制列表</button><button data-copy="json">复制 JSON</button>
                        <div class="menu-separator" role="separator"></div><button data-download="json">导出 JSON</button>
                        <div class="menu-separator" role="separator"></div><button id="diagnose">复制诊断信息</button>
                    </div></details>
                </nav>
                <div class="body"><table><colgroup><col class="index"><col class="song"><col class="artist"><col></colgroup><thead><tr><th scope="col">#</th><th scope="col">歌曲</th><th scope="col">歌手</th><th scope="col">专辑</th></tr></thead><tbody></tbody></table></div>
                <footer id="status" role="status" aria-live="polite">点击扫描当前歌单</footer>
            </dialog><div id="notice" role="status" hidden></div>`;
        document.body.appendChild(host);
        const $ = selector => root.querySelector(selector);
        const dialog = $('dialog');
        const version = typeof GM_info === 'object' ? GM_info.script.version : 'dev';
        let songs = [], controller = null, noticeTimer, scanned = false;
        let route = location.href;
        const setStatus = text => { $('#status').textContent = text; };
        const notify = text => {
            const notice = $('#notice');
            notice.textContent = text;
            notice.hidden = false;
            clearTimeout(noticeTimer);
            noticeTimer = setTimeout(() => { notice.hidden = true; }, 2500);
        };
        function render() {
            const fragment = document.createDocumentFragment();
            songs.forEach((song, index) => {
                const row = document.createElement('tr');
                [index + 1, song.name, song.artist, song.album].forEach(value => {
                    const cell = document.createElement('td');
                    cell.textContent = String(value);
                    cell.title = String(value);
                    row.appendChild(cell);
                });
                fragment.appendChild(row);
            });
            if (!songs.length) {
                const row = document.createElement('tr'), cell = document.createElement('td');
                cell.colSpan = 4;
                cell.textContent = '尚无歌曲。请等待歌单加载，或重新扫描。';
                row.appendChild(cell);
                fragment.appendChild(row);
            }
            $('tbody').replaceChildren(fragment);
            $('#count').textContent = `${songs.length} 首`;
            $('#playlist-name').textContent = clean(document.querySelector('h1')?.textContent) || 'Apple Music';
        }
        function busy(value) {
            $('#rescan').disabled = value;
            $('#stop').hidden = !value;
            root.querySelectorAll('[data-copy], [data-download]').forEach(button => { button.disabled = value || !songs.length; });
        }
        async function doScan() {
            if (controller || !playlistId(location.href)) return;
            const current = new AbortController();
            controller = current;
            busy(true);
            setStatus('正在读取歌单数据…');
            try {
                const result = await scan(document, { signal: current.signal,
                    onProgress: (count, total) => setStatus(`正在加载：已收集 ${count}${total == null ? '' : ` / ${total}`} 首，可取消`) });
                if (current.signal.aborted) return;
                songs = result.songs;
                scanned = true;
                render();
                if (result.complete) setStatus('已提取全部歌曲');
                else if (result.reason === 'timeout') setStatus(`已达扫描时间上限，提取 ${songs.length} 首；可重新扫描`);
                else if (result.expected != null) setStatus(`提取 ${songs.length} / ${result.expected} 首，页面可能仍有未加载或不可用歌曲`);
                else setStatus(`提取 ${songs.length} 首；页面未提供总数，无法确认完整性`);
            } catch (error) {
                if (error.name === 'AbortError') setStatus('扫描已取消');
                else { setStatus('扫描失败，请重试或复制诊断信息'); console.error('[AM Extractor]', error); }
            } finally {
                if (controller === current) { controller = null; busy(false); }
            }
        }
        async function copy(text) {
            try {
                if (typeof GM_setClipboard === 'function') GM_setClipboard(text, 'text');
                else await navigator.clipboard.writeText(text);
                notify('已复制到剪贴板');
            } catch { notify('复制失败，请使用下载按钮'); }
        }
        function close() { controller?.abort(); $('#more').open = false; dialog.close(); $('#launch').focus(); }
        $('#launch').addEventListener('click', () => { if (!dialog.open) dialog.showModal(); if (!scanned) void doScan(); });
        $('#close').addEventListener('click', close);
        dialog.addEventListener('cancel', () => { controller?.abort(); $('#more').open = false; });
        root.addEventListener('click', event => {
            if (!$('#more').contains(event.target) || event.target.closest('button')) $('#more').open = false;
        });
        dialog.addEventListener('click', event => {
            const rect = dialog.getBoundingClientRect();
            if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right
                || event.clientY < rect.top || event.clientY > rect.bottom)) close();
        });
        $('#rescan').addEventListener('click', () => { void doScan(); });
        $('#stop').addEventListener('click', () => { controller?.abort(); });
        root.querySelectorAll('[data-copy]').forEach(button => button.addEventListener('click', () => {
            if (songs.length && !controller) void copy(format(songs, button.dataset.copy));
        }));
        root.querySelectorAll('[data-download]').forEach(button => button.addEventListener('click', () => {
            if (!songs.length || controller) return;
            const type = button.dataset.download;
            const blob = new Blob([type === 'csv' ? '\uFEFF' : '', format(songs, type)], { type: type === 'csv' ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8' });
            const url = URL.createObjectURL(blob), link = document.createElement('a');
            link.href = url;
            const title = clean(document.querySelector('h1')?.textContent) || 'Apple Music 歌单';
            link.download = `${title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100)}.${type}`;
            root.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }));
        $('#diagnose').addEventListener('click', () => {
            const rows = findRows(document);
            const embedded = readEmbedded(document, location.href);
            void copy(JSON.stringify({ version, playlistId: playlistId(location.href), visibleRows: rows.length,
                embeddedSongs: embedded.songs.length, expected: embedded.expected, firstRow: rows[0] ? parseRow(rows[0]) : null }, null, 2));
        });
        function checkRoute() {
            const next = location.href;
            if (next !== route) {
                controller?.abort();
                if (dialog.open) dialog.close();
                songs = []; scanned = false; route = next; render();
                busy(Boolean(controller));
                setStatus('点击扫描当前歌单');
            }
            $('#launch').hidden = !playlistId(next);
        }
        checkRoute(); render(); busy(false);
        // Apple Music navigates without a document reload, including from non-playlist pages.
        const routeTimer = setInterval(checkRoute, 800);
        window.addEventListener('pagehide', event => {
            controller?.abort();
            if (!event.persisted) clearInterval(routeTimer);
        });
    }

    return { playlistId, songId, parseRow, findRows, readEmbedded, expectedCount, createCollector, publicSongs, scan, format, boot };
});
