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
      return json({
        records,
        // 空振りしたときは、DAM側が何と言って断ったのかをそのまま見せる
        message: records.length ? "" : (errors.join(" / ") || "歌唱履歴が見つかりませんでした。"),
      }, cors);
    } catch (e) {
      return json({ error: e.message || "取得に失敗しました。" }, cors);
    }
  },
};

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
          if (pageNo === 1) errors.push(`${type.name}: ${reason || status[1]}`);
          break;
        }
        all.push(...parseScoringPage(xml, type, damtomoId));
        const hn = xml.match(/<page[^>]*hasNext="([^"]+)"/);
        hasNext = hn && hn[1] === "1";
        pageNo++;
        if (pageNo > 50) break;
      } catch (e) {
        if (pageNo === 1) errors.push(`${type.name}: ${e.message}`);
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
    });
  }
  return records;
}

function formatDate(dt) {
  if (!dt || dt.length < 8) return "";
  return `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}`;
}
