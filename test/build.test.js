const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');

test('publishing increases versions even when the clock moves backwards; local builds preserve versions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'am-build-test-'));
    try {
        mkdirSync(join(dir, 'scripts'));
        mkdirSync(join(dir, 'src'));
        copyFileSync(join(__dirname, '../scripts/build.mjs'), join(dir, 'scripts/build.mjs'));
        writeFileSync(join(dir, 'src/extractor.js'), '(function () {})();\n');
        const build = (stamp, bump) => execFileSync(process.execPath, [join(dir, 'scripts/build.mjs')], {
            env: { ...process.env, GITHUB_REPOSITORY: 'example/playlist', BUILD_VERSION_TIMESTAMP: String(stamp), BUMP_VERSION: bump ? '1' : '0' },
        });
        const meta = () => readFileSync(join(dir, 'apple-music-playlist-extractor.meta.js'), 'utf8');
        build(100, false);
        assert.match(meta(), /@version\s+3\.0\.100\n/);
        build(200, false);
        assert.match(meta(), /@version\s+3\.0\.100\n/);
        build(50, true);
        assert.match(meta(), /@version\s+3\.0\.101\n/);
        const full = readFileSync(join(dir, 'apple-music-playlist-extractor.user.js'), 'utf8');
        assert.ok(full.startsWith(meta()));
        assert.match(meta(), /@updateURL\s+https:\/\/raw\.githubusercontent\.com\/example\/playlist\/main\/apple-music-playlist-extractor\.meta\.js/);
        assert.match(meta(), /@downloadURL\s+https:\/\/raw\.githubusercontent\.com\/example\/playlist\/main\/apple-music-playlist-extractor\.user\.js/);
        assert.match(meta(), /@namespace\s+http:\/\/tampermonkey\.net\//);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
