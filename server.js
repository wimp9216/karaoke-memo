/* =========================================================
   Karaoke Memo — ローカルサーバー
   index.html を配信しつつ、DAM★とも の精密採点履歴を取得する
   proxy API を提供します。

   使い方:  node server.js   →  http://localhost:5174

   ※ 外部依存なし（Node 18+ の組み込み fetch / TextDecoder を使用）
   ※ 取得方式は karaoke-expo54-app の server.js と同じ:
      プロフィールページ → cdmCardNo / cdmToken を抽出 →
      精密採点XMLを全ページ取得（detailFlg=1）→ パース
   ========================================================= */
const http = require("http");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const port = Number(process.env.PORT || 5174);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);

    if (url.pathname === "/api/health") {
      sendJson(response, 200, { status: "ok", port, message: "backend running" });
      return;
    }

    if (url.pathname === "/api/damtomo/history") {
      await handleDamtomoHistory(url, response);
      return;
    }

    serveStatic(url.pathname, response);
  } catch (error) {
    sendJson(response, 500, { error: error.message || "Internal server error" });
  }
});

server.listen(port, () => {
  console.log(`\n  Karaoke Memo:  http://localhost:${port}`);
  console.log(`  ヘルスチェック: http://localhost:${port}/api/health\n`);
});

/* =========================================================
   DAM★とも 精密採点履歴の取得
   ========================================================= */
async function handleDamtomoHistory(url, response) {
  try {
    const damtomoId = sanitizeDamtomoId(url.searchParams.get("damtomoId") || "");
    const debug = url.searchParams.get("debug") === "1";

    if (!damtomoId) {
      sendJson(response, 400, { error: "damtomoId が不正です。" });
      return;
    }

    console.log(`\n=== DAM★とも履歴を取得: ${damtomoId} ===`);

    // プロフィールページから cdmCardNo と cdmToken を取得
    const profileUrl = `https://www.clubdam.com/app/damtomo/member/info/Profile.do?damtomoId=${encodeURIComponent(damtomoId)}`;
    const profileHtml = await fetchShiftJis(profileUrl);

    let cdmCardNo = extractValue(profileHtml, /var cdmCardNo = '([^']+)'/);
    if (!cdmCardNo) cdmCardNo = extractValue(profileHtml, /cdmCardNo\s*=\s*['"]([^'"]+)['"]/);
    if (!cdmCardNo) cdmCardNo = extractValue(profileHtml, /name="cdmCardNo"[^>]*value="([^"]+)"/);

    let cdmToken = extractValue(profileHtml, /var cdmToken = '([^']+)'/);
    if (!cdmToken) cdmToken = extractValue(profileHtml, /cdmToken\s*=\s*['"]([^'"]+)['"]/);
    if (!cdmToken) cdmToken = extractValue(profileHtml, /name="cdmToken"[^>]*value="([^"]+)"/);

    if (debug) {
      const idx = profileHtml.indexOf("cdmToken");
      sendJson(response, 200, {
        debug: true,
        cdmCardNo: cdmCardNo || "NOT FOUND",
        cdmToken: cdmToken ? cdmToken.slice(0, 16) + "..." : "NOT FOUND",
        htmlLength: profileHtml.length,
        snippet: idx >= 0 ? profileHtml.slice(Math.max(0, idx - 120), idx + 300) : "cdmToken not in HTML",
      });
      return;
    }

    if (!cdmCardNo || !cdmToken) {
      sendJson(response, 200, {
        records: [],
        message:
          "認証情報(cdmCardNo/cdmToken)を取得できませんでした。DAM★とものプロフィールが公開設定になっているか確認してください。",
      });
      return;
    }

    console.log(`cdmCardNo: ${cdmCardNo.slice(0, 8)}... / cdmToken: あり`);

    const records = await fetchAllScoringPages(cdmCardNo, cdmToken, damtomoId);
    console.log(`✓ 合計 ${records.length} 件を取得\n`);

    sendJson(response, 200, {
      records,
      message: records.length ? "" : "歌唱履歴が見つかりませんでした。",
    });
  } catch (error) {
    console.error("DAM★とも取得エラー:", error);
    sendJson(response, 500, { error: error.message || "取得に失敗しました。" });
  }
}

// 3つの採点モードから全ページ取得（karaoke-expo54-app と同じ取得手順）
async function fetchAllScoringPages(cdmCardNo, cdmToken, damtomoId) {
  const allRecords = [];

  const scoringTypes = [
    { name: "精密採点DX-G", endpoint: "GetScoringDxgListXML.do", tag: "scoring", idAttr: "scoringDxgId", kind: "dxg" },
    { name: "精密採点Ai", endpoint: "GetScoringAiListXML.do", tag: "scoring", idAttr: "scoringAiId", kind: "ai" },
    { name: "精密採点AiHeart", endpoint: "GetScoringHeartsListXML.do", tag: "scoringHearts", idAttr: "scoringHeartsHistoryId", kind: "hearts" },
  ];

  for (const type of scoringTypes) {
    console.log(`--- ${type.name} ---`);
    let pageNo = 1;
    let hasNext = true;

    while (hasNext) {
      const apiUrl =
        `https://www.clubdam.com/app/damtomo/scoring/${type.endpoint}` +
        `?cdmCardNo=${encodeURIComponent(cdmCardNo)}&cdmToken=${encodeURIComponent(cdmToken)}` +
        `&enc=sjis&pageNo=${pageNo}&detailFlg=1&UTCserial=${Date.now()}`;

      try {
        const xmlText = await fetchShiftJis(apiUrl);

        const statusMatch = xmlText.match(/<status>([^<]*)<\/status>/);
        if (statusMatch && statusMatch[1] !== "OK") {
          const msgMatch = xmlText.match(/<message>([^<]*)<\/message>/);
          console.warn(`  ${type.name}: ${msgMatch ? msgMatch[1] : "エラー"}（スキップ）`);
          break;
        }

        const records = parseScoringPage(xmlText, type, damtomoId);
        allRecords.push(...records);
        console.log(`  ページ${pageNo}: ${records.length}件`);

        const hasNextMatch = xmlText.match(/<page[^>]*hasNext="([^"]+)"/);
        hasNext = hasNextMatch && hasNextMatch[1] === "1";
        pageNo++;

        if (pageNo > 50) { console.warn(`  最大ページ数(50)に到達`); break; }
        await sleep(120); // API負荷軽減
      } catch (error) {
        console.warn(`  ${type.name} ページ${pageNo} 失敗: ${error.message}`);
        hasNext = false;
      }
    }
  }

  return allRecords;
}

// 1ページ分のXMLから各楽曲の要点を抽出（軽量表示用: 総合点・素点・採点方式など）
function parseScoringPage(xmlText, type, damtomoId) {
  const records = [];
  const tagRegex = new RegExp(`<${type.tag}\\s[\\s\\S]*?</${type.tag}>`, "g");
  let match;

  while ((match = tagRegex.exec(xmlText)) !== null) {
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

    // 総合点: totalScore属性、なければタグ内テキスト（Ai/DX-Gはタグ内が総合点）
    const innerMatch = block.match(new RegExp(`>(\\d+)</${type.tag}>`));
    const totalScoreRaw = attr("totalScore") || (innerMatch ? innerMatch[1] : null);
    const totalScore = totalScoreRaw ? parseFloat(totalScoreRaw) / 1000 : null;

    // 素点計算: AiHeart=総合点-ハートボーナス / Ai=総合点-Ai感性ボーナス / DX-G=そのまま
    let bonus = null;
    let rawScore = totalScore;
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
      sungAt: formatScoringDate(attr("scoringDateTime")),
      mode: type.name,
      damtomoId,
    });
  }

  return records;
}

function formatScoringDate(datetime) {
  // 20260513194747 → 2026-05-13
  if (!datetime || datetime.length < 8) return "";
  return `${datetime.slice(0, 4)}-${datetime.slice(4, 6)}-${datetime.slice(6, 8)}`;
}

/* =========================================================
   ユーティリティ
   ========================================================= */
function extractValue(html, regex) {
  const m = html.match(regex);
  return m ? m[1] : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// clubdam.com は Shift-JIS。UTF-8で試して化けたら Shift-JIS でデコード
async function fetchShiftJis(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "karaoke-memo/1.0",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  if (!response.ok) throw new Error(`DAM★とも が ${response.status} を返しました。`);

  const buffer = Buffer.from(await response.arrayBuffer());
  let text = buffer.toString("utf8");

  const needsSjis =
    text.includes("�") ||
    /encoding=["'](shift[_-]?jis|sjis)["']/i.test(text.slice(0, 200));
  if (needsSjis) {
    try {
      text = new TextDecoder("shift_jis").decode(buffer);
    } catch {
      /* full-ICU が無い環境では UTF-8 のまま */
    }
  }
  return text;
}

function sanitizeDamtomoId(value) {
  return decodeURIComponent(value).trim().match(/^[A-Za-z0-9_+/-]+={0,2}$/)?.[0] || "";
}

function serveStatic(requestPath, response) {
  const pathname = requestPath === "/" ? "/index.html" : requestPath;
  const filePath = path.resolve(root, `.${pathname}`);
  if (!filePath.startsWith(root)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    response.writeHead(200, { "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream" });
    response.end(data);
  });
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  response.end(JSON.stringify(body));
}
