import fs from "node:fs/promises";
import crypto from "node:crypto";

const HARDCODED_KEYWORD = "A-Lin";

const TARGET_URL = process.env.TARGET_URL;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const STATE_FILE = "state.json";

if (!TARGET_URL || !DISCORD_WEBHOOK_URL) {
  console.error("缺少必要環境變數：TARGET_URL 或 DISCORD_WEBHOOK_URL");
  process.exit(1);
}

function htmlToPlainText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findKeywordMatch(html, keyword) {
  const lowerKeyword = keyword.toLowerCase();

  // 1. 先比對純文字（不分大小寫）
  const plainText = htmlToPlainText(html);
  const plainLower = plainText.toLowerCase();
  const plainIdx = plainLower.indexOf(lowerKeyword);

  if (plainIdx !== -1) {
    const start = Math.max(0, plainIdx - 60);
    const end = Math.min(plainText.length, plainIdx + keyword.length + 120);
    return {
      matched: true,
      source: "plainText",
      snippet: plainText.slice(start, end)
    };
  }

  // 2. 若純文字沒抓到，再比對原始 HTML（包含內嵌 JSON / 屬性等）
  const rawLower = html.toLowerCase();
  const rawIdx = rawLower.indexOf(lowerKeyword);

  if (rawIdx !== -1) {
    const cleanedRaw = html.replace(/\s+/g, " ");
    const cleanedLower = cleanedRaw.toLowerCase();
    const idx = cleanedLower.indexOf(lowerKeyword);
    const start = Math.max(0, idx - 60);
    const end = Math.min(cleanedRaw.length, idx + keyword.length + 120);
    return {
      matched: true,
      source: "rawHtml",
      snippet: cleanedRaw.slice(start, end)
    };
  }

  return {
    matched: false,
    source: "none",
    snippet: ""
  };
}

async function readState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      messageId: parsed.messageId || "",
      lastNotifiedHash: parsed.lastNotifiedHash || ""
    };
  } catch {
    return { messageId: "", lastNotifiedHash: "" };
  }
}

async function writeState(state) {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2) + "\n", "utf8");
}

function formatTaiwanTime(date = new Date()) {
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
}

function buildStatusEmbed({ matched, snippet, source, errorMsg }) {
  const nowStr = formatTaiwanTime();

  if (errorMsg) {
    return {
      username: "網頁更新狀態板",
      embeds: [
        {
          title: "⚠️ 監控異常（抓取或連線失敗）",
          url: TARGET_URL,
          color: 0xe74c3c,
          fields: [
            { name: "限定文字", value: `\`${HARDCODED_KEYWORD}\``, inline: true },
            { name: "最後巡檢時間", value: `\`${nowStr}\``, inline: true },
            { name: "錯誤訊息", value: errorMsg.slice(0, 400), inline: false }
          ],
          timestamp: new Date().toISOString()
        }
      ]
    };
  }

  return {
    username: "網頁更新狀態板",
    embeds: [
      {
        title: matched
          ? `🟢 已出現關鍵字：「${HARDCODED_KEYWORD}」`
          : `🔵 監控中（尚未出現：「${HARDCODED_KEYWORD}」）`,
        url: TARGET_URL,
        description: matched
          ? `**命中來源：** \`${source}\`\n**擷取片段：**\n${snippet.slice(0, 500)}`
          : "目前抓到的網頁內容中尚未偵測到指定關鍵字（可能為動態渲染或雲端 IP 限制），每 5 分鐘自動巡檢並原地更新此狀態。",
        color: matched ? 0x2ecc71 : 0x3498db,
        fields: [
          { name: "監控狀態", value: matched ? "已命中關鍵字" : "等待更新中", inline: true },
          { name: "限定文字", value: `\`${HARDCODED_KEYWORD}\``, inline: true },
          { name: "最後更新時間", value: `\`${nowStr}\``, inline: false }
        ],
        timestamp: new Date().toISOString()
      }
    ]
  };
}

async function upsertPinnedStatusMessage(messageId, payload) {
  if (messageId) {
    const patchRes = await fetch(`${DISCORD_WEBHOOK_URL}/messages/${messageId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (patchRes.ok) {
      return messageId;
    }

    if (patchRes.status !== 404) {
      const errText = await patchRes.text();
      throw new Error(`更新固定訊息失敗 (${patchRes.status}): ${errText}`);
    }
  }

  const createRes = await fetch(`${DISCORD_WEBHOOK_URL}?wait=true`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!createRes.ok) {
    const errText = await createRes.text();
    throw new Error(`建立固定訊息失敗 (${createRes.status}): ${errText}`);
  }

  const created = await createRes.json();
  return created.id;
}

async function sendSingleHitCard(snippet, source) {
  const nowStr = formatTaiwanTime();
  const payload = {
    username: "網頁更新即時通知",
    embeds: [
      {
        title: `🚨 偵測到限定關鍵字：「${HARDCODED_KEYWORD}」`,
        url: TARGET_URL,
        description: `**擷取內容：**\n${snippet.slice(0, 600)}`,
        color: 0xf1c40f,
        fields: [
          { name: "觸發關鍵字", value: `\`${HARDCODED_KEYWORD}\``, inline: true },
          { name: "比對來源", value: `\`${source}\``, inline: true },
          { name: "偵測時間", value: `\`${nowStr}\``, inline: false }
        ],
        timestamp: new Date().toISOString()
      }
    ]
  };

  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`單張通知卡片發送失敗 (${res.status}): ${errText}`);
  }
}

async function main() {
  const state = await readState();

  try {
    const res = await fetch(TARGET_URL, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Accept":
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
        "Cache-Control": "no-cache"
      }
    });

    if (!res.ok) {
      throw new Error(`抓取網頁失敗 (${res.status})：${TARGET_URL}`);
    }

    const html = await res.text();
    console.log(`已抓取 HTML 長度：${html.length} 字元`);

    const result = findKeywordMatch(html, HARDCODED_KEYWORD);
    let contentHash = "";

    if (result.matched) {
      contentHash = crypto
        .createHash("sha256")
        .update(`${HARDCODED_KEYWORD}:${result.snippet}`)
        .digest("hex");

      if (state.lastNotifiedHash !== contentHash) {
        await sendSingleHitCard(result.snippet, result.source);
      }
    }

    const statusPayload = buildStatusEmbed({
      matched: result.matched,
      snippet: result.snippet,
      source: result.source,
      errorMsg: ""
    });
    const nextMessageId = await upsertPinnedStatusMessage(state.messageId, statusPayload);

    await writeState({
      messageId: nextMessageId,
      lastNotifiedHash: result.matched ? contentHash : state.lastNotifiedHash
    });

    console.log(
      result.matched
        ? `已原地更新狀態訊息 (${nextMessageId})，命中來源：${result.source}。`
        : `已原地更新狀態訊息 (${nextMessageId})，尚未命中關鍵字。`
    );
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const errorPayload = buildStatusEmbed({
      matched: false,
      snippet: "",
      source: "none",
      errorMsg
    });
    const nextMessageId = await upsertPinnedStatusMessage(state.messageId, errorPayload);

    await writeState({
      ...state,
      messageId: nextMessageId
    });

    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
