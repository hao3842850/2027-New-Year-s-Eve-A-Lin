import fs from "node:fs/promises";
import crypto from "node:crypto";

const TARGET_URL = process.env.TARGET_URL;
const WATCH_KEYWORD = process.env.WATCH_KEYWORD || "更新";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const SEND_EXTRA_ALERT = process.env.SEND_EXTRA_ALERT !== "false";
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

function buildStatusEmbed({ matched, snippet, errorMsg }) {
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
            { name: "限定文字", value: `\`${WATCH_KEYWORD}\``, inline: true },
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
          ? `🟢 已出現更新文字：「${WATCH_KEYWORD}」`
          : `🔵 監控中（尚未出現：「${WATCH_KEYWORD}」）`,
        url: TARGET_URL,
        description: matched
          ? `**擷取片段：**\n${snippet.slice(0, 500)}`
          : "目前頁面純文字中尚未偵測到指定關鍵字，每 5 分鐘自動巡檢並原地更新此狀態。",
        color: matched ? 0x2ecc71 : 0x3498db,
        fields: [
          { name: "監控狀態", value: matched ? "已命中更新" : "等待更新中", inline: true },
          { name: "限定文字", value: `\`${WATCH_KEYWORD}\``, inline: true },
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

    // 若訊息在 Discord 被手動刪除（404），則重新建立一則新的固定訊息
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

async function sendExtraAlert(snippet) {
  const payload = {
    username: "網頁更新即時通知",
    content: `🚨 偵測到限定文字 **「${WATCH_KEYWORD}」**！`,
    embeds: [
      {
        title: `網頁出現更新：${WATCH_KEYWORD}`,
        url: TARGET_URL,
        description: snippet.slice(0, 500),
        color: 0xf1c40f,
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
    throw new Error(`額外通知發送失敗 (${res.status}): ${errText}`);
  }
}

async function main() {
  const state = await readState();

  try {
    const res = await fetch(TARGET_URL, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Cache-Control": "no-cache"
      }
    });

    if (!res.ok) {
      throw new Error(`抓取網頁失敗 (${res.status})：${TARGET_URL}`);
    }

    const html = await res.text();
    const plainText = htmlToPlainText(html);
    const index = plainText.indexOf(WATCH_KEYWORD);
    const matched = index !== -1;

    let snippet = "";
    let contentHash = "";

    if (matched) {
      const start = Math.max(0, index - 60);
      const end = Math.min(plainText.length, index + WATCH_KEYWORD.length + 120);
      snippet = plainText.slice(start, end);
      contentHash = crypto
        .createHash("sha256")
        .update(`${WATCH_KEYWORD}:${snippet}`)
        .digest("hex");

      if (SEND_EXTRA_ALERT && state.lastNotifiedHash !== contentHash) {
        await sendExtraAlert(snippet);
      }
    }

    const statusPayload = buildStatusEmbed({ matched, snippet, errorMsg: "" });
    const nextMessageId = await upsertPinnedStatusMessage(state.messageId, statusPayload);

    await writeState({
      messageId: nextMessageId,
      lastNotifiedHash: matched ? contentHash : state.lastNotifiedHash
    });

    console.log(
      matched
        ? `已原地更新狀態訊息 (${nextMessageId})，偵測到關鍵字「${WATCH_KEYWORD}」。`
        : `已原地更新狀態訊息 (${nextMessageId})，尚未偵測到關鍵字。`
    );
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const errorPayload = buildStatusEmbed({ matched: false, snippet: "", errorMsg });
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
