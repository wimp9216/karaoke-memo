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

   ※ 精密採点XML APIは UTF-8 で返るため、Shift-JIS 変換は不要。
     プロフィールページは Shift-JIS だが、必要な cdmCardNo / cdmToken は
     ASCII なので UTF-8 デコードでも問題なく抽出できる。
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

    try {
      const profile = await getText(
        `https://www.clubdam.com/app/damtomo/member/info/Profile.do?damtomoId=${encodeURIComponent(damtomoId)}`
      );
      let cdmCardNo = extract(profile, /var cdmCardNo = '([^']+)'/) || extract(profile, /cdmCardNo\s*=\s*['"]([^'"]+)['"]/);
      let cdmToken  = extract(profile, /var cdmToken = '([^']+)'/)  || extract(profile, /cdmToken\s*=\s*['"]([^'"]+)['"]/);

      if (!cdmCardNo || !cdmToken) {
        return json({
          records: [],
          message: "認証情報(cdmCardNo/cdmToken)を取得できませんでした。DAM★とものプロフィールが公開設定か確認してください。",
        }, cors);
      }

      const records = await fetchAllScoringPages(cdmCardNo, cdmToken, damtomoId);
      return json({ records, message: records.length ? "" : "歌唱履歴が見つかりませんでした。" }, cors);
    } catch (e) {
      return json({ error: e.message || "取得に失敗しました。" }, cors);
    }
  },
};

function json(body, cors) {
  return new Response(JSON.stringify(body), { headers: cors });
}

function extract(text, regex) {
  const m = text.match(regex);
  return m ? m[1] : null;
}

// UTF-8 として読む（scoring XMLはUTF-8、profileのトークンはASCIIなので可）
async function getText(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "karaoke-memo/1.0",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
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
        if (status && status[1] !== "OK") break;
        all.push(...parseScoringPage(xml, type, damtomoId));
        const hn = xml.match(/<page[^>]*hasNext="([^"]+)"/);
        hasNext = hn && hn[1] === "1";
        pageNo++;
        if (pageNo > 50) break;
      } catch {
        hasNext = false;
      }
    }
  }
  return all;
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
