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
        root.innerHTML = `
            <style>
                :host { all: initial; color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
                * { box-sizing: border-box; }
                button { font: inherit; color: #f5f5f7; cursor: pointer; border: 1px solid #ffffff24; background: #ffffff0c; border-radius: 8px; padding: 8px 12px; }
                button:hover { background: #ffffff22; }
                button:focus-visible { outline: 2px solid #ff6b79; outline-offset: 3px; }
                button:disabled { cursor: default; opacity: .4; }
                [hidden] { display: none !important; }
                #launch { position: fixed; right: 24px; bottom: 100px; z-index: 2147483646; width: 52px; height: 52px; padding: 0; border: 0; border-radius: 50%; font-size: 25px; background: linear-gradient(135deg, #fc3c44, #e8175d); box-shadow: 0 4px 20px #fc3c4460; }
                dialog { width: min(850px, 94vw); max-height: 85dvh; padding: 0; color: #f5f5f7; background: #1c1c1e; border: 1px solid #ffffff20; border-radius: 16px; box-shadow: 0 12px 60px #0009; }
                dialog[open] { display: flex; flex-direction: column; }
                dialog::backdrop { background: #0008; backdrop-filter: blur(4px); }
                header { display: flex; align-items: center; gap: 12px; padding: 16px 20px; border-bottom: 1px solid #ffffff18; }
                h2 { flex: 1; margin: 0; font-size: 18px; }
                #count { color: #b9b9bf; font-size: 13px; }
                nav { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px 20px; font-size: 13px; }
                .body { overflow: auto; min-height: 100px; }
                table { width: 100%; border-collapse: collapse; text-align: left; font-size: 13px; }
                th { position: sticky; top: 0; background: #2c2c2e; color: #b9b9bf; }
                th, td { padding: 10px 14px; border-bottom: 1px solid #ffffff0c; }
                td { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                tr:hover td { background: #ffffff08; }
                footer { padding: 12px 20px; border-top: 1px solid #ffffff18; color: #b9b9bf; font-size: 12px; line-height: 1.5; }
                #notice { position: fixed; bottom: 35px; left: 50%; transform: translateX(-50%); padding: 12px 20px; border-radius: 12px; background: #333; color: white; z-index: 2147483647; font-size: 14px; max-width: 90vw; }
                @media (max-width: 600px) { th, td { padding: 8px; } nav, header, footer { padding: 12px; } td { max-width: 140px; } }
            </style>
            <button id="launch" title="提取歌单歌曲" aria-label="提取歌单歌曲" hidden>🎵</button>
            <dialog aria-labelledby="heading">
                <header><h2 id="heading">🎵 歌单歌曲</h2><span id="count"></span><button id="close" aria-label="关闭">✕</button></header>
                <nav aria-label="导出与扫描">
                    <button data-copy="table">复制表格</button><button data-copy="csv">复制 CSV</button>
                    <button data-copy="list">复制列表</button><button data-copy="json">复制 JSON</button>
                    <button data-download="csv">下载 CSV</button><button data-download="json">下载 JSON</button>
                    <button id="rescan">重新扫描</button><button id="stop" hidden>取消扫描</button><button id="diagnose">诊断</button>
                </nav>
                <div class="body"><table><thead><tr><th>#</th><th>歌曲</th><th>歌手</th><th>专辑</th></tr></thead><tbody></tbody></table></div>
                <footer id="status" role="status" aria-live="polite">点击扫描当前歌单</footer>
            </dialog><div id="notice" role="status" hidden></div>`;
        document.body.appendChild(host);
        const $ = selector => root.querySelector(selector);
        const dialog = $('dialog');
        const version = typeof GM_info === 'object' ? GM_info.script.version : 'dev';
        let songs = [], controller = null, noticeTimer, scanned = false;
        let route = location.href;
        const setStatus = text => { $('#status').textContent = `${text} · v${version}`; };
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
            $('#count').textContent = `共 ${songs.length} 首`;
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
                if (result.complete) setStatus(`扫描完成，共 ${songs.length} 首`);
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
        function close() { controller?.abort(); dialog.close(); $('#launch').focus(); }
        $('#launch').addEventListener('click', () => { if (!dialog.open) dialog.showModal(); if (!scanned) void doScan(); });
        $('#close').addEventListener('click', close);
        dialog.addEventListener('cancel', () => { controller?.abort(); });
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
