// Published dates on list pages: a date without a zone is read in the source's offset, whatever zone
// the server runs in (Docker runs in UTC; run this file with TZ=UTC and TZ=Asia/Shanghai to see both).
import assert from "node:assert/strict";
import { test } from "node:test";
import http from 'node:http';
import { config } from '@aihot/backend/config';
import { parseLooseDate, fetchDetail } from "@aihot/backend/sources/web-list";
import { assertSupportedConfig } from "@aihot/backend/sources/config-keys";
import type { SourceRow } from '@aihot/backend/sources/types';

const iso = (v: string, offset?: string) => parseLooseDate(v, offset)?.toISOString() ?? null;

test("a date and time without a zone is in the source's offset, not the server's", () => {
  assert.equal(iso("2026-09-26 10:00"), "2026-09-26T02:00:00.000Z");
  assert.equal(iso("2026-09-26T10:00:00"), "2026-09-26T02:00:00.000Z");
  assert.equal(iso("2026/09/26 10:00"), "2026-09-26T02:00:00.000Z");
  assert.equal(iso("2026年9月26日 10:00"), "2026-09-26T02:00:00.000Z");
  assert.equal(iso("2026-09-26 10:00", "-07:00"), "2026-09-26T17:00:00.000Z");
});

test("a bare date is midnight in the source's offset; an ISO date alone stays UTC midnight", () => {
  assert.equal(iso("2026/09/26"), "2026-09-25T16:00:00.000Z");
  assert.equal(iso("2026年9月26日"), "2026-09-25T16:00:00.000Z");
  assert.equal(iso("Sep 26, 2026"), "2026-09-25T16:00:00.000Z");
  assert.equal(iso("2026-09-26"), "2026-09-26T00:00:00.000Z");
  assert.equal(iso("September 26th, 2026", "+00:00"), "2026-09-26T00:00:00.000Z");
});

test("a date that carries its zone keeps it", () => {
  assert.equal(iso("2026-09-26T10:00:00Z"), "2026-09-26T10:00:00.000Z");
  assert.equal(iso("2026-09-26T10:00:00.000+09:00"), "2026-09-26T01:00:00.000Z");
  assert.equal(iso("Sat, 26 Sep 2026 10:00:00 GMT"), "2026-09-26T10:00:00.000Z");
  assert.equal(iso("Sat, 26 Sep 2026 10:00:00 +0200", "-07:00"), "2026-09-26T08:00:00.000Z");
});

test("no date at all is null", () => {
  assert.equal(iso(""), null);
  assert.equal(iso("yesterday"), null);
});

test("epoch publication values require an explicit unit and do not inherit the server or source timezone", () => {
  const expected = '2026-10-10T14:53:30.000Z';
  assert.equal(parseLooseDate('1791644010', '+08:00', 'epoch_s')?.toISOString(), expected);
  assert.equal(parseLooseDate('1791644010000', '-07:00', 'epoch_ms')?.toISOString(), expected);
  assert.equal(parseLooseDate('1791644010'), null);
  assert.equal(parseLooseDate('2026-10-10', '+08:00', 'epoch_s'), null);
  assert.equal(parseLooseDate('999999999999999999999', '+08:00', 'epoch_s'), null);
  assert.doesNotThrow(() => assertSupportedConfig('web_list', {detail:{publishedAtUnit:'epoch_s'}}));
  assert.throws(() => assertSupportedConfig('web_list', {detail:{publishedAtUnit:'auto'}}), /detail.publishedAtUnit/);
});

test('authoritative epoch detail dates reach collection without falling back to an unrelated page timestamp', async () => {
  const server = http.createServer((req,res) => {
    res.writeHead(200,{'content-type':'text/html'});
    res.end(`<meta property="article:published_time" content="2020-01-01T00:00:00Z"><article${req.url==='/dated'?' data-article-publish-time="1791644010"':''}><p>News text</p></article>`);
  });
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  const previous = config.allowPrivateNetworkFetch;
  config.allowPrivateNetworkFetch = true;
  try {
    const source = {config:{detail:{publishedAtRegex:'data-article-publish-time="([0-9]+)"',publishedAtUnit:'epoch_s',publishedAtAuthoritative:true}}} as SourceRow;
    const base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
    const need = {date:true,title:false,summary:false,body:false};
    assert.equal((await fetchDetail(`${base}/dated`,source,need,{strictHttp:true})).publishedAt?.toISOString(),'2026-10-10T14:53:30.000Z');
    assert.equal((await fetchDetail(`${base}/missing`,source,need,{strictHttp:true})).publishedAt,null);
  } finally {
    config.allowPrivateNetworkFetch = previous;
    await new Promise<void>(resolve => server.close(()=>resolve()));
  }
});
