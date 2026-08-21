/* =========================================================
   Karaoke Memo — DAM★とも 取得 proxy（Cloudflare Worker）
   ---------------------------------------------------------
   GitHub Pages 等の静的サイトから精密採点履歴を取得するための中継。
   ブラウザは CORS で clubdam.com を直接叩けないため、この Worker が
   代理でアクセスして JSON を返します（あなた専用・無料枠でOK）。

   使い方（Cloudflare ダッシュボード）:
     1. https://dash.cloudflare.com → Workers & Pages → Create → Worker
     2. 適当な名前を付けて Deploy
     3. 「Edit code」→ このファイルの中身を全部貼り付け → Deploy
     4. 発行された URL（https://<name>.<sub>.workers.dev）を
        カラオケメモの「取得サーバー(proxy)の設定」に貼って保存

   ※ 精密採点XML APIは enc=utf8 を付けるので UTF-8 で読む。
     プロフィールページは Shift-JIS(Windows-31J) なので、ASCIIのトークンだけを
     確実に拾えるよう latin1（バイト＝文字）で読む。

   ※ cdmToken は「本人がログイン中のときだけ」値が入る。公開プロフィールを
     第三者が見た場合は必ず var cdmToken = ''; になる。
     ただし採点APIはスクランブル済みの cdmCardNo だけで公開履歴を返すため、
     トークンが空でも取得を打ち切らないこと（ここで諦めるのが従来の不具合だった）。
   ========================================================= */

export default {
  async fetch(request) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json; charset=utf-8",
    };
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: { ...cors, "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "*" },
      });
    }

    const url = new URL(request.url);

    // 曲の音域を調べる（アカウント不要）
    const songQ = url.searchParams.get("songRange");
    if (songQ != null) {
      try {
        return json(await lookupSongRange(
          songQ, url.searchParams.get("artist") || "", url.searchParams.get("debug") === "1"), cors);
      } catch (e) {
        return json({ found: false, message: "音域の取得に失敗しました: " + e.message }, cors);
      }
    }

    const damtomoId = (url.searchParams.get("damtomoId") || "").match(/^[A-Za-z0-9_+/-]+={0,2}$/)?.[0] || "";
    if (!damtomoId) return json({ error: "damtomoId が不正です。" }, cors);
    const debug = url.searchParams.get("debug") === "1";

    const profileUrl =
      `https://www.clubdam.com/app/damtomo/member/info/Profile.do?damtomoId=${encodeURIComponent(damtomoId)}`;

    try {
      const page = await getPage(profileUrl);
      const { cdmCardNo, cdmToken } = extractTokens(page.text);

      // ?debug=1 で、何がどこまで取れているかを返す（トークンの値そのものは出さない）
      if (debug) return json(diagnose(page, cdmCardNo, cdmToken), cors);

      // cdmToken は本人がログインしているときだけ入る。空でもまず叩いてみる
      if (!cdmCardNo) {
        return json({
          records: [],
          message:
            `会員番号(cdmCardNo)をプロフィールページから取得できませんでした。` +
            `ページは HTTP ${page.status} / ${page.text.length} 文字で取得できています。` +
            `末尾に &debug=1 を付けて開くと詳細が確認できます。`,
        }, cors);
      }

      const { records, errors } = await fetchAllScoringPages(cdmCardNo, cdmToken || "", damtomoId);

      // ?fields=1 で、採点種別ごとにどんな内訳項目が取れるかだけを返す
      if (url.searchParams.get("fields") === "1") {
        const byMode = {};
        for (const r of records) {
          const e = (byMode[r.mode] ||= { count: 0, keys: new Set(), sample: null });
          e.count++;
          Object.keys(r.detail || {}).forEach((k) => e.keys.add(k));
          if (!e.sample) e.sample = r.detail;
        }
        return json({
          fields: true,
          total: records.length,
          modes: Object.fromEntries(
            Object.entries(byMode).map(([m, e]) => [m, { count: e.count, keys: [...e.keys].sort(), sample: e.sample }])
          ),
        }, cors);
      }

      return json({
        records,
        // 一部の採点種別だけ失敗することがあるので、成功時でも理由は必ず返す
        errors,
        counts: countByMode(records),
        message: records.length ? "" : (errors.join(" / ") || "歌唱履歴が見つかりませんでした。"),
      }, cors);
    } catch (e) {
      return json({ error: e.message || "取得に失敗しました。" }, cors);
    }
  },
};

/* =========================================================
   曲の音域を音域系サイトから引く
   ・いずれも WordPress で ?s= 検索が使え、
     記事に「地声最低音　mid1F（F3）」の形で載っている
   ・1サイトでは収録漏れが多いので、見つかるまで順に当たる
   ・違う曲のデータを掴むと害が大きいので、曲名が一致しない候補は採らない
   ========================================================= */
const RANGE_SOURCES = [
  {
    name: "音域研究所", base: "https://onikikenkyujo.com", path: "\\d{4}/\\d{2}/\\d{2}/.+",
    search: (q) => [`/?s=${encodeURIComponent(q)}`],
  },
  {
    name: "J-POP 音域の沼", base: "https://vocal-range.com", path: "archives/.+\\.html",
    search: (q) => [`/?s=${encodeURIComponent(q)}`],
  },
  {
    name: "KeyTube", base: "https://keytube.net", path: "song/(?:detail|lyrics)/\\d+",
    // 曲名検索のパラメータ名を確認できていないので、ありそうな形を順に試す。
    // 記事リンクが1件でも取れた時点で「その形が正しい」と判断して打ち切る
    search: (q) => {
      const e = encodeURIComponent(q);
      return [
        `/search/bpm?keyword=${e}`,
        `/search/bpm?q=${e}`,
        `/song/?keyword=${e}`,
        `/search?keyword=${e}`,
      ];
    },
  },
];
const NOTE_RE = "(?:hihi|hi|mid1|mid2|lowlow|low)[A-G](?:#|♯)?";

function normJa(s) {
  return String(s ?? "").toLowerCase().replace(/[\s　]+/g, "")
    .replace(/[（）()『』「」【】［］\[\]＆&・,，.。'’"”!！?？~〜\-–—]/g, "");
}

async function lookupSongRange(title, artist, debug) {
  title = String(title || "").trim();
  if (!title) return { found: false, message: "曲名がありません。" };

  const tried = [];
  const trace = [];                             // debug=1 のときだけ返す
  for (const src of RANGE_SOURCES) {
    tried.push(src.name);
    // まず曲名＋アーティスト。表記違いで空振りしたら曲名だけで引き直す
    const queries = artist ? [`${title} ${artist}`, title] : [title];
    for (const q of queries) {
      for (const path of src.search(q)) {
        const step = { source: src.name, query: q, path };
        let hits;
        try {
          const html = await getUtf8(src.base + path);
          step.htmlLength = html.length;
          hits = pickResults(html, src);
        } catch (e) {
          step.error = e.message; trace.push(step); continue;   // 落ちたら次の形を試す
        }
        step.hitCount = hits.length;
        step.hits = hits.slice(0, 6).map((h) => ({ url: h.url, match: h.match }));

        const best = bestMatch(hits, title, artist);
        step.matched = best ? best.url : null;
        trace.push(step);

        if (!best) {
          // 記事リンクが取れているなら検索URLの形は正しい＝この曲が無いだけ
          if (hits.length) break;
          continue;                             // 1件も取れないなら別の形を試す
        }

        const r = parseRangePage(await getUtf8(best.url));
        step.parsed = r;
        if (!r.high || !r.low) break;           // 読めなければ次のクエリ／サイトへ
        const out = { found: true, pageTitle: best.text, url: best.url, source: src.name, ...r };
        return debug ? { ...out, trace } : out;
      }
    }
  }
  const out = { found: false, message: `該当する曲が見つかりませんでした（${tried.join(" / ")}を確認）。` };
  return debug ? { ...out, trace } : out;
}

/**
 * 検索結果ページから記事リンクを拾う。
 * href は相対のこともあり、アンカーの中身がサムネイル画像だけのこともあるので、
 * URL解決はブラウザのURLに任せ、照合用の文字列は複数の手がかりから作る
 */
function pickResults(html, src) {
  const host = new URL(src.base).host;
  const pathRe = new RegExp("^" + src.path + "$");
  const byUrl = new Map();

  for (const m of html.matchAll(/<a\b[^>]*?href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let u;
    try { u = new URL(decodeEntities(m[1]).trim(), src.base); } catch { continue; }
    if (u.host !== host) continue;
    if (!pathRe.test(u.pathname.replace(/^\/+/, ""))) continue;

    const inner = m[2];
    const alt = (inner.match(/\balt=["']([^"']*)["']/i) || [])[1] || "";
    const text = decodeEntities(inner.replace(/<[^>]*>/g, " ") + " " + alt).replace(/\s+/g, " ").trim();

    const url = u.origin + u.pathname;
    const prev = byUrl.get(url);
    if (!prev || text.length > prev.text.length) byUrl.set(url, { url, text });
  }

  // スラッグ自体が日本語のタイトルになっているサイトが多いので、照合の手がかりに足す
  return [...byUrl.values()].map((h) => ({ ...h, match: `${h.text} ${slugText(h.url)}` }));
}

function slugText(url) {
  try {
    const last = new URL(url).pathname.replace(/\/+$/, "").split("/").pop() || "";
    return decodeURIComponent(last).replace(/[-_+]+/g, " ");
  } catch { return ""; }
}

/** 曲名が一致しているものだけ採用する（別の曲を掴まないため） */
function bestMatch(hits, title, artist) {
  const t = normJa(title), a = normJa(artist);
  let best = null, bestScore = 0;
  for (const h of hits) {
    const x = normJa(h.match || h.text);
    if (!t || !x.includes(t)) continue;         // 曲名一致は必須
    const score = 2 + (a && x.includes(a) ? 1 : 0);
    if (score > bestScore) { bestScore = score; best = h; }
  }
  return best;
}

/**
 * 記事から音域を読む。
 * 「地声最低音」と書くサイトと、単に「最低音」と書くサイトがあるので、
 * 地声の表記を優先しつつ、無ければ素の表記にも当たる。
 * ただし「裏声最高音」を「最高音」として拾うと高すぎる値になるため、
 * 素の表記を探すときは直前に裏声が付いていないものだけを採る
 */
function parseRangePage(html) {
  const text = decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ");
  const pick = (...labels) => {
    for (const label of labels) {
      const m = text.match(new RegExp("(?<!裏声)(?<!ファルセット)" + label + "[\\s　:：]*(" + NOTE_RE + ")"));
      if (m) return m[1].replace("♯", "#");
    }
    return null;
  };
  return {
    low: pick("地声最低音", "最低音"),
    high: pick("地声最高音", "最高音"),
    falsetto: (text.match(new RegExp("裏声最高音[\\s　:：]*(" + NOTE_RE + ")")) || [])[1] || null,
  };
}

function decodeEntities(s) {
  return s.replace(/&(amp|lt|gt|quot|#0?39|apos|nbsp|#8217|#8211);/g, (_, e) => ({
    amp: "&", lt: "<", gt: ">", quot: '"', "#039": "'", "#39": "'", apos: "'",
    nbsp: " ", "#8217": "’", "#8211": "–",
  }[e] || _));
}

async function getUtf8(url) {
  const res = await fetch(url, { headers: BROWSER_HEADERS, redirect: "follow" });
  if (!res.ok) throw new Error(`${new URL(url).hostname} が ${res.status} を返しました`);
  return new TextDecoder("utf-8").decode(await res.arrayBuffer());
}

function countByMode(records) {
  const out = {};
  for (const r of records) out[r.mode] = (out[r.mode] || 0) + 1;
  return out;
}

/** 取得できたページの素性を報告する。値は伏せ、形と長さだけ出す */
function diagnose(page, cdmCardNo, cdmToken) {
  const t = page.text;
  const varNames = [...t.matchAll(/var\s+([A-Za-z_$][\w$]*)\s*=/g)].map((m) => m[1]);

  // 採点履歴への現在の導線を洗い出す（サイト構造が変わっていれば正しいURLが分かる）
  const links = [...t.matchAll(/(?:href|action)\s*=\s*["']([^"']*[Ss]coring[^"']*)["']/g)].map((m) => m[1]);

  return {
    debug: true,
    httpStatus: page.status,
    contentType: page.contentType,
    htmlLength: t.length,
    finalUrl: page.finalUrl,
    looksLikeErrorPage: /URLが見つかりません|アクセスするURLが見つかりません/.test(t),
    contains: {
      cdmCardNo: t.includes("cdmCardNo"),
      cdmToken: t.includes("cdmToken"),
      damtomoId: t.includes("damtomoId"),
    },
    found: { cdmCardNo: !!cdmCardNo, cdmToken: !!cdmToken },
    lengths: { cdmCardNo: (cdmCardNo || "").length, cdmToken: (cdmToken || "").length },
    varNames: [...new Set(varNames)].slice(0, 60),
    // 宣言の「書き方」だけ見たいので、値は伏せる
    cdmCardNoDecl: maskDecl(t, "cdmCardNo"),
    cdmTokenDecl: maskDecl(t, "cdmToken"),
    scoringLinks: [...new Set(links)].slice(0, 25),
  };
}

/** `var name = '...'` の周辺を、値を伏せた形で返す */
function maskDecl(text, name) {
  const i = text.indexOf(name);
  if (i < 0) return null;
  const around = text.slice(Math.max(0, i - 12), i + 110).replace(/\s+/g, " ");
  return around.replace(/(['"])([^'"]*)\1/g, (_, q, v) => `${q}${v ? "*".repeat(v.length) : ""}${q}`);
}

/** cdmCardNo / cdmToken を、書き方の揺れに強い形で拾う */
function extractTokens(text) {
  const pick = (name) =>
    extract(text, new RegExp(`var\\s+${name}\\s*=\\s*['"]([^'"]+)['"]`)) ||
    extract(text, new RegExp(`${name}\\s*[:=]\\s*['"]([^'"]+)['"]`)) ||
    extract(text, new RegExp(`${name}=([A-Za-z0-9%._-]+)`));           // クエリ文字列内
  return { cdmCardNo: pick("cdmCardNo"), cdmToken: pick("cdmToken") };
}

function json(body, cors) {
  return new Response(JSON.stringify(body), { headers: cors });
}

function extract(text, regex) {
  const m = text.match(regex);
  return m ? m[1] : null;
}

/* 素のUAだと別ページを返すサイトがあるため、ブラウザ相当を名乗る */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const BROWSER_HEADERS = {
  "User-Agent": UA,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "ja,en;q=0.8",
};

/**
 * プロフィールページ用。Shift-JIS のページから ASCII のトークンを拾うので、
 * バイトを1対1で文字にするlatin1で読む（多バイト解釈による取りこぼしを避ける）
 */
async function getPage(url) {
  const res = await fetch(url, { headers: BROWSER_HEADERS, redirect: "follow" });
  const buf = await res.arrayBuffer();
  return {
    status: res.status,
    contentType: res.headers.get("content-type") || "",
    finalUrl: res.url || url,
    text: latin1(buf),
  };
}

function latin1(buf) {
  const a = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < a.length; i += 8192) s += String.fromCharCode(...a.subarray(i, i + 8192));
  return s;
}

// 採点XMLは enc=utf8 を付けて取るので UTF-8 で読む
async function getText(url) {
  const res = await fetch(url, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`DAM★とも が ${res.status} を返しました。`);
  const buf = await res.arrayBuffer();
  return new TextDecoder("utf-8").decode(buf);
}

const SCORING_TYPES = [
  { name: "精密採点DX-G", endpoint: "GetScoringDxgListXML.do",    tag: "scoring",      idAttr: "scoringDxgId",           kind: "dxg" },
  { name: "精密採点Ai",   endpoint: "GetScoringAiListXML.do",     tag: "scoring",      idAttr: "scoringAiId",            kind: "ai" },
  { name: "精密採点AiHeart", endpoint: "GetScoringHeartsListXML.do", tag: "scoringHearts", idAttr: "scoringHeartsHistoryId", kind: "hearts" },
];

async function fetchAllScoringPages(cdmCardNo, cdmToken, damtomoId) {
  const all = [];
  const errors = [];
  for (const type of SCORING_TYPES) {
    let pageNo = 1, hasNext = true;
    while (hasNext) {
      const apiUrl =
        `https://www.clubdam.com/app/damtomo/scoring/${type.endpoint}` +
        `?cdmCardNo=${encodeURIComponent(cdmCardNo)}&cdmToken=${encodeURIComponent(cdmToken)}` +
        `&enc=utf8&pageNo=${pageNo}&detailFlg=1&UTCserial=${Date.now()}`;
      try {
        const xml = await getText(apiUrl);
        const status = xml.match(/<status>([^<]*)<\/status>/);
        if (status && status[1] !== "OK") {
          // DAM側の断り文句を拾っておく（原因が分からないまま空になるのを防ぐ）
          const reason = extract(xml, /<message>([^<]*)<\/message>/) || extract(xml, /<error[^>]*>([^<]*)<\/error>/);
          errors.push(`${type.name}: ${reason || status[1]}（${pageNo}ページ目）`);
          break;
        }
        const got = parseScoringPage(xml, type, damtomoId);
        all.push(...got);
        if (pageNo === 1 && !got.length) {
          // status は OK なのに1件も取れない＝タグ名が想定と違う可能性がある
          errors.push(`${type.name}: 応答は正常ですが <${type.tag}> を取り出せませんでした`);
        }
        const hn = xml.match(/<page[^>]*hasNext="([^"]+)"/);
        hasNext = hn && hn[1] === "1";
        pageNo++;
        if (pageNo > 50) break;
      } catch (e) {
        errors.push(`${type.name}: ${e.message}（${pageNo}ページ目）`);
        hasNext = false;
      }
    }
  }
  return { records: all, errors };
}

function parseScoringPage(xml, type, damtomoId) {
  const records = [];
  const tagRegex = new RegExp(`<${type.tag}\\s[\\s\\S]*?</${type.tag}>`, "g");
  let match;
  while ((match = tagRegex.exec(xml)) !== null) {
    const block = match[0];
    const attr = (name) => {
      const m = block.match(new RegExp(`\\s${name}="([^"]*)"`));
      return m ? m[1] : null;
    };
    const numAttr = (name) => {
      const v = attr(name);
      return v !== null && v !== "" ? parseFloat(v) : null;
    };

    const title = attr("songName") || attr("contentsName");
    if (!title) continue;

    const innerMatch = block.match(new RegExp(`>(\\d+)</${type.tag}>`));
    const totalScoreRaw = attr("totalScore") || (innerMatch ? innerMatch[1] : null);
    const totalScore = totalScoreRaw ? parseFloat(totalScoreRaw) / 1000 : null;

    let bonus = null, rawScore = totalScore;
    if (type.kind === "hearts") {
      const hp = numAttr("hearingPoint");
      if (hp !== null) { bonus = hp / 1000; if (totalScore !== null) rawScore = Math.round((totalScore - bonus) * 1000) / 1000; }
    } else if (type.kind === "ai") {
      const ab = numAttr("aiSensitivityBonus");
      if (ab !== null) { bonus = ab / 1000; if (totalScore !== null) rawScore = Math.round((totalScore - bonus) * 1000) / 1000; }
    }

    records.push({
      id: attr(type.idAttr) || null,
      title,
      artist: attr("artistName") || "",
      score: totalScore,
      rawScore,
      bonus,
      sungAt: formatDate(attr("scoringDateTime")),
      mode: type.name,
      damtomoId,
      detail: buildDetail(block),
    });
  }
  return records;
}

/** ブロック内の属性を name→value でそのまま取り出す */
function allAttrs(block) {
  const out = {};
  for (const m of block.matchAll(/\s([A-Za-z_][\w.:-]*)="([^"]*)"/g)) {
    if (m[2] !== "") out[m[1]] = m[2];
  }
  return out;
}

/* 端末のlocalStorageに何百件も貯まるので、生の属性をそのまま持たず整形して詰める。
   ・24区間のグラフは配列に畳む
   ・採点機種ごとに項目が違うので、無いものは省く
   ・拾い漏らした項目は extra に残して取りこぼさない */
const CONSUMED = new RegExp(
  "^(" +
  "songName|artistName|contentsName|scoringDateTime|damtomoId|cdmCardNo|edyId|damserial" +
  "|dataKind|dataSize|scoringEngineVersionNumber|spare\\d+|.*Id|.*No\\d*|entryCount|topRecordNumber" +
  "|requestNoTray|requestNoChapter|totalScore|lastPerformKey|requestNo" +
  "|radarChart\\w+|nationalAverage\\w+|maxTotalPoints|rankingRank|rankingRankAll" +
  "|singingRange\\w+|vocalRange\\w+|intonation|timing" +
  "|\\w+Count|longtoneSkill|vibratoSkill|vibratoType|vibratoTotalSecond" +
  "|hearingType|hearingPoint|aiSensitivityBonus|scoreType|fadeout|favorite|medalKind|intonationType|intonationScore" +
  "|intervalGraph\\w+|hearingGraph\\w+" +
  ")$"
);

function buildDetail(block) {
  const a = allAttrs(block);
  const n = (k) => (a[k] != null && a[k] !== "" ? Number(a[k]) : null);
  const d = {};
  const put = (k, v) => { if (v != null && !(typeof v === "number" && isNaN(v))) d[k] = v; };

  put("key", n("lastPerformKey"));            // 実際に歌ったキー
  put("requestNo", a.requestNo);

  // 6軸レーダー（本人 / 全国平均）
  const radar = pick(n, {
    pitch: "radarChartPitch", stability: "radarChartStability", expressive: "radarChartExpressive",
    vibratoLongtone: "radarChartVibratoLongtone", rhythm: "radarChartRhythm", hearing: "radarChartHearing",
  });
  const avgRadar = pick(n, {
    pitch: "nationalAveragePitch", stability: "nationalAverageStability", expressive: "nationalAverageExpression",
    vibratoLongtone: "nationalAverageVibratoAndLongtone", rhythm: "nationalAverageRhythm", hearing: "nationalAverageHearing",
  });
  if (Object.keys(radar).length) put("radar", radar);
  if (Object.keys(avgRadar).length) put("avgRadar", avgRadar);

  put("nationalAvg", n("nationalAverageTotalPoints") != null ? n("nationalAverageTotalPoints") / 1000 : null);
  put("maxScore", n("maxTotalPoints") != null ? n("maxTotalPoints") / 1000 : null);
  put("rank", n("rankingRank"));
  put("rankAll", n("rankingRankAll"));

  // 声域（MIDIノート番号）
  const high = n("singingRangeHighest") ?? n("vocalRangeHighest");
  const low  = n("singingRangeLowest")  ?? n("vocalRangeLowest");
  if (high != null || low != null) put("range", { high, low });

  put("intonation", n("intonation"));         // 抑揚
  put("timing", n("timing"));                 // タメ⇔走り

  const counts = pick(n, {
    shakuri: "shakuriCount", kobushi: "kobushiCount", fall: "fallCount", accent: "accentCount",
    hammeringOn: "hammeringOnCount", pullingOff: "pullingOffCount",
    edgeVoice: "edgeVoiceCount", hiccup: "hiccupCount", flydown: "flydownCount",
  });
  if (Object.keys(counts).length) put("counts", counts);

  const longtone = pick(n, { skill: "longtoneSkill", count: "longtoneCount" });
  if (Object.keys(longtone).length) put("longtone", longtone);

  const vib = pick(n, { skill: "vibratoSkill", type: "vibratoType", count: "vibratoCount" });
  if (n("vibratoTotalSecond") != null) vib.totalSec = n("vibratoTotalSecond") / 10;
  if (Object.keys(vib).length) put("vibrato", vib);

  put("hearingType", n("hearingType"));
  put("commentNo", n("analysisReportCommentNo"));

  put("pitchGraph", sections(a, "intervalGraphPointsSection", Number));
  put("pitchIndex", sections(a, "intervalGraphIndexSection", sectionKind));
  put("hearGraph",  sections(a, "hearingGraphPtSection", Number));
  put("hearIndex",  sections(a, "hearingGraphIxSection", sectionKind));

  // 機種ごとの未知の項目を拾っておく（区間グラフのような嵩張るものは除く）
  const extra = {};
  for (const [k, v] of Object.entries(a)) if (!CONSUMED.test(k)) extra[k] = v;
  if (Object.keys(extra).length) put("extra", extra);

  return Object.keys(d).length ? d : null;
}

function pick(n, map) {
  const out = {};
  for (const [to, from] of Object.entries(map)) { const v = n(from); if (v != null) out[to] = v; }
  return out;
}

/** 区間の種別 "B'00"(区間なし) / "B'01"(通常) / "B'10"(サビ) を 0/1/2 に畳む */
function sectionKind(v) {
  const m = String(v).match(/B'(\d+)/);
  if (!m) return 0;
  return m[1] === "10" ? 2 : (m[1] === "00" ? 0 : 1);
}

/** xxxSection01..24 を配列に畳む。全区間が空なら null */
function sections(a, prefix, cast) {
  const out = [];
  for (let i = 1; i <= 24; i++) {
    const v = a[prefix + String(i).padStart(2, "0")];
    out.push(v == null || v === "" ? null : cast(v));
  }
  return out.some((v) => v != null) ? out : null;
}

function formatDate(dt) {
  if (!dt || dt.length < 8) return "";
  return `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}`;
}
