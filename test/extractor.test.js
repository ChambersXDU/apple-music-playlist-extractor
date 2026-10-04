const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { JSDOM } = require('jsdom');
const api = require('../src/extractor.js');

const url = 'https://music.apple.com/cn/playlist/example/pl.test';
const page = html => new JSDOM(html, { url });
const row = (name, artist = 'Artist', album = 'Album', index = 0, id = index + 1) => `<div class="songs-list-row" role="row" data-testid="track-list-item" data-row="${index}">
    <div class="songs-list-row__song-container"><div class="songs-list-row__song-name-wrapper"><a href="/cn/song/title/${id}"><div data-testid="track-title">${name}</div></a><a href="/cn/artist/artist/1">${artist}</a></div></div>
    <a href="/cn/artist/artist/1">${artist}</a><a href="/cn/album/album/10">${album}</a></div>`;
const embedded = (titles = ['One', 'Two'], id = 'pl.test', total = titles.length) => JSON.stringify({ data: [{
    intent: { contentDescriptor: { kind: 'playlist', identifiers: { storeAdamID: id } } },
    data: { sections: [{ items: [{ trackCount: total }] }, { id: `track-list - ${id}`, itemKind: 'trackLockup', items: titles.map((title, index) => ({
        title, artistName: 'Artist', tertiaryLinks: [{ title: 'Album' }],
        contentDescriptor: { kind: 'song', identifiers: { storeAdamID: String(index + 1) } },
    })) }] },
}] });
const script = data => `<script type="application/json" id="serialized-server-data">${data}</script>`;

test('all storefronts and short playlist URLs, without matching albums', () => {
    assert.equal(api.playlistId(url), 'pl.test');
    assert.equal(api.playlistId('https://music.apple.com/us/playlist/pl.123?l=en'), 'pl.123');
    assert.equal(api.playlistId('https://music.apple.com/jp/album/test/12'), '');
});

test('real Apple row shape: nested wrappers do not suppress rows or repeat artists', () => {
    const dom = page(`<main><div role="row"><div role="columnheader">歌曲</div></div>${row('Same')}${row('Same', 'Other', 'Live', 1, 2)}</main>`);
    const rows = api.findRows(dom.window.document);
    assert.equal(rows.length, 2);
    assert.deepEqual(api.parseRow(rows[0]), { name: 'Same', artist: 'Artist', album: 'Album', id: '1', position: 1 });
    dom.window.close();
});

test('song links under albums are not mistaken for the album name', () => {
    const dom = page('<div><a href="/cn/album/test/1?i=200">A song</a><a href="/cn/album/test/1">The album</a></div>');
    const parsed = api.parseRow(dom.window.document.body.firstElementChild);
    assert.equal(parsed.name, 'A song');
    assert.equal(parsed.album, 'The album');
    assert.equal(parsed.id, '200');
    dom.window.close();
});

test('deduplication retains namesakes, alternate recordings and intentional repeats', () => {
    const c = api.createCollector();
    [{ name: 'Same', artist: 'A', album: 'X', id: '1', position: 1 },
     { name: 'Same', artist: 'B', album: 'X', id: '2', position: 2 },
     { name: 'Same', artist: 'A', album: 'Live', id: '3', position: 3 },
     { name: 'Same', artist: 'A', album: 'X', id: '1', position: 4 }].forEach(song => c.add(song));
    c.add({ name: 'Same', artist: '', album: '', id: '1', position: 1 });
    assert.equal(c.size, 4);
    assert.equal(c.values()[0].artist, 'A');
});

test('missing identity uses name, artist and album together', () => {
    const c = api.createCollector();
    c.add({ name: 'Song', artist: 'A', album: 'X' });
    c.add({ name: 'Song', artist: 'B', album: 'X' });
    c.add({ name: 'Song', artist: 'A', album: 'Live' });
    assert.equal(c.size, 3);
});

test('embedded data is accepted only for the current playlist', () => {
    const dom = page(script(embedded()));
    assert.equal(api.readEmbedded(dom.window.document, url).songs.length, 2);
    assert.equal(api.readEmbedded(dom.window.document, url.replace('pl.test', 'pl.other')).songs.length, 0);
    dom.window.close();
});

test('malformed embedded JSON falls back without throwing', () => {
    const dom = page(script('{broken'));
    assert.deepEqual(api.readEmbedded(dom.window.document, url), { songs: [], expected: null });
    dom.window.close();
});

test('complete embedded playlist returns immediately without scrolling', async () => {
    const dom = page(script(embedded()));
    dom.window.document.documentElement.scrollTop = 73;
    const result = await api.scan(dom.window.document);
    assert.equal(result.complete, true);
    assert.equal(result.songs.length, 2);
    assert.equal(dom.window.document.documentElement.scrollTop, 73);
    dom.window.close();
});

test('hydrated DOM plus footer count returns without network or scrolling', async () => {
    const dom = page(`<main>${row('One')}${row('Two', 'B', 'Y', 1)}</main><div data-testid="tracklist-footer-description">2 首歌曲、7 分钟</div>`);
    dom.window.fetch = () => { throw new Error('Should not fetch'); };
    const result = await api.scan(dom.window.document);
    assert.equal(result.complete, true);
    assert.equal(result.reason, 'count');
    assert.equal(result.songs.length, 2);
    dom.window.close();
});

test('removed server JSON is recovered from the same playlist HTML', async () => {
    const dom = page(`<main>${row('One')}</main><div data-testid="tracklist-footer-description">2 songs, 7 minutes</div>`);
    dom.window.AbortSignal = AbortSignal;
    let requested;
    dom.window.fetch = async address => {
        requested = address;
        return { ok: true, url: address, text: async () => script(embedded()) };
    };
    const result = await api.scan(dom.window.document);
    assert.equal(requested, url);
    assert.equal(result.complete, true);
    assert.deepEqual(result.songs.map(song => song.name), ['One', 'Two']);
    dom.window.close();
});

test('HTML redirects to another playlist do not mix its songs into the result', async () => {
    const dom = page(`<main>${row('One')}</main>`);
    dom.window.AbortSignal = AbortSignal;
    dom.window.fetch = async () => ({ ok: true, url: url.replace('pl.test', 'pl.other'), text: async () => script(embedded(['Wrong'], 'pl.other')) });
    const result = await api.scan(dom.window.document, { interval: 1, idleDuration: 3, maxDuration: 100 });
    assert.deepEqual(result.songs.map(song => song.name), ['One']);
    dom.window.close();
});

test('virtual rows are accumulated during incremental scrolling and scroll is restored', async () => {
    const dom = page(`<main style="overflow-y:auto"><div id="rows"></div></main>`);
    const main = dom.window.document.querySelector('main');
    const rows = dom.window.document.querySelector('#rows');
    let top = 50;
    Object.defineProperties(main, {
        scrollHeight: { value: 900 }, clientHeight: { value: 300 },
        scrollTop: { get: () => top, set: value => {
            top = value;
            const index = Math.floor(value / 240);
            rows.innerHTML = row(`Song ${index + 1}`, 'A', 'X', index);
        } },
    });
    main.scrollTop = 50;
    const result = await api.scan(dom.window.document, { interval: 1, idleDuration: 5, maxDuration: 1000 });
    assert.deepEqual(result.songs.map(song => song.name), ['Song 1', 'Song 2', 'Song 3']);
    assert.equal(top, 50);
    assert.equal(result.complete, false);
    dom.window.close();
});

test('abort stops a pending scan and restores scroll', async () => {
    const dom = page(`<main>${row('One')}</main>`);
    dom.window.document.documentElement.scrollTop = 91;
    const c = new AbortController();
    const promise = api.scan(dom.window.document, { signal: c.signal, interval: 50 });
    setTimeout(() => c.abort(), 5);
    await assert.rejects(promise, { name: 'AbortError' });
    assert.equal(dom.window.document.documentElement.scrollTop, 91);
    dom.window.close();
});

test('route changes stop scans before old playlist results can be displayed', async () => {
    const dom = page(`<main>${row('One')}</main>`);
    const promise = api.scan(dom.window.document, { interval: 5 });
    dom.window.history.pushState({}, '', '/cn/playlist/other/pl.other');
    await assert.rejects(promise, { name: 'AbortError' });
    dom.window.close();
});

test('incomplete known playlist is not reported as complete', async () => {
    const dom = page(script(embedded(['One'], 'pl.test', 10)));
    const result = await api.scan(dom.window.document, { interval: 1, idleDuration: 3, maxDuration: 100 });
    assert.equal(result.complete, false);
    assert.equal(result.expected, 10);
    dom.window.close();
});

test('CSV escapes quotes, commas, newlines and spreadsheet formulas', () => {
    const csv = api.format([{ name: 'A,"B"\nC', artist: '=1+1', album: ' -2' }], 'csv');
    assert.ok(csv.includes('"A,""B""\nC"'));
    assert.ok(csv.includes('"\'=1+1"'));
    assert.ok(csv.includes('"\' -2"'));
    assert.ok(csv.includes('\r\n'));
});

test('JSON preserves exact song text', () => {
    const songs = [{ name: '=1+1', artist: 'A', album: 'X' }];
    assert.deepEqual(JSON.parse(api.format(songs, 'json')), songs);
});

test('UI renders song text safely and reuses one host', async () => {
    const dangerous = '\"<img src=x onerror=alert(1)> & song';
    const dom = new JSDOM(script(embedded([dangerous])), { url, runScripts: 'outside-only' });
    dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
    dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
    dom.window.eval(readFileSync(require.resolve('../src/extractor.js'), 'utf8'));
    dom.window.eval(readFileSync(require.resolve('../src/extractor.js'), 'utf8'));
    assert.equal(dom.window.document.querySelectorAll('#am-extractor-host').length, 1);
    const root = dom.window.document.querySelector('#am-extractor-host').shadowRoot;
    root.querySelector('#launch').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(root.querySelector('tbody td:nth-child(2)').textContent, dangerous);
    assert.equal(root.querySelector('tbody img'), null);
    assert.equal(root.querySelector('#status').textContent, '已提取全部歌曲');
    dom.window.close();
});
