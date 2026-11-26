import fs from "node:fs/promises";
import crypto from "node:crypto";

const TARGET_URL = process.env.TARGET_URL;
const WATCH_KEYWORD = process.env.WATCH_KEYWORD || "更新";
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

async function readState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return { lastNotifiedHash: "" };
  }
}

async function writeState(state) {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2) + "\n", "utf8");
}

async function sendDiscordNotification(matchedSnippet) {
  const payload = {
    username: "網頁更新監控機器人",
    embeds: [
      {
        title: `偵測到關鍵字：「${WATCH_KEYWORD}」`,
        url: TARGET_URL,
        description: `**擷取片段：**\n${matchedSnippet.slice(0, 500)}`,
        color: 0x2ecc71,
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
    throw new Error(`Discord Webhook 發送失敗 (${res.status}): ${errText}`);
  }
}

async function main() {
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

  if (index === -1) {
    console.log(`未發現關鍵字「${WATCH_KEYWORD}」。`);
    return;
  }

  const start = Math.max(0, index - 60);
  const end = Math.min(plainText.length, index + WATCH_KEYWORD.length + 120);
  const snippet = plainText.slice(start, end);
  const contentHash = crypto
    .createHash("sha256")
    .update(`${WATCH_KEYWORD}:${snippet}`)
    .digest("hex");

  const state = await readState();
  if (state.lastNotifiedHash === contentHash) {
    console.log("已通知過相同內容，略過重複推播。");
    return;
  }

  await sendDiscordNotification(snippet);
  await writeState({ lastNotifiedHash: contentHash });
  console.log("已成功發送 Discord 通知並更新 state.json。");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
