// Publishes approved Instagram posts that are due. Runs on GitHub Actions every 15 minutes
// (.github/workflows/ig-post.yml), so posts go out at 9 AM / 7 PM even when the Mac is off.
//
// Reads ig-queue/*.json (written by the Mac after the owners approve; only approved posts are in it)
// and writes ig-queue/posted.json. Needs repo secrets IG_USER_ID and IG_ACCESS_TOKEN.
//   node .github/scripts/ig_post.mjs              # post what's due
//   node .github/scripts/ig_post.mjs --check ID   # build the container for one post but don't publish (setup test)

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";

const { IG_USER_ID, IG_ACCESS_TOKEN } = process.env;
const API = `https://graph.facebook.com/${process.env.IG_API_VERSION || "v26.0"}`;
if (!IG_USER_ID || !IG_ACCESS_TOKEN) { console.log("Instagram isn't connected yet (no IG_USER_ID / IG_ACCESS_TOKEN secrets). Nothing to do."); process.exit(0); }

const LOG = "ig-queue/posted.json";
const posted = existsSync(LOG) ? JSON.parse(readFileSync(LOG, "utf8")) : {};
const queue = readdirSync("ig-queue").filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
  .flatMap((f) => JSON.parse(readFileSync(`ig-queue/${f}`, "utf8")).items || []);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LATE_LIMIT = 3 * 3600e3; // a "tonight" post more than 3 hours late is skipped, not posted
const MAX_TRIES = 3;

async function call(path, params, method = "POST") {
  const body = new URLSearchParams({ ...params, access_token: IG_ACCESS_TOKEN });
  const r = method === "GET" ? await fetch(`${API}/${path}?${body}`) : await fetch(`${API}/${path}`, { method, body });
  const j = await r.json();
  if (j.error) { const e = new Error(`${j.error.message} (code ${j.error.code}${j.error.error_subcode ? "/" + j.error.error_subcode : ""})`); e.code = j.error.code; throw e; }
  return j;
}
// Optional fields (alt text, collaborators) are retried without them if the API rejects them.
async function container(params, optional = {}) {
  try { return (await call(`${IG_USER_ID}/media`, { ...params, ...optional })).id; }
  catch (e) { if (Object.keys(optional).length && e.code === 100) { console.log(`  (retrying without ${Object.keys(optional).join(", ")}: ${e.message})`); return (await call(`${IG_USER_ID}/media`, params)).id; } throw e; }
}
async function ready(id, minutes = 8) {
  for (let i = 0; i < minutes * 6; i++) {
    const { status_code, status } = await call(id, { fields: "status_code,status" }, "GET");
    if (status_code === "FINISHED") return;
    if (status_code === "ERROR" || status_code === "EXPIRED") throw new Error(`Media processing ${status_code}: ${status || ""}`);
    await sleep(10000);
  }
  throw new Error("Media still processing after 8 minutes");
}

async function build(item) {
  const collab = item.collaborators?.length ? { collaborators: JSON.stringify(item.collaborators) } : {};
  const alt = (i) => (item.alt?.[i] ? { alt_text: item.alt[i].slice(0, 1000) } : {});
  if (item.type === "story") {
    const id = await container(item.video ? { media_type: "STORIES", video_url: item.video } : { media_type: "STORIES", image_url: item.images[0] });
    await ready(id); return id;
  }
  if (item.type === "reel") {
    const id = await container({ media_type: "REELS", video_url: item.video, caption: item.caption, share_to_feed: "true", ...(item.cover ? { cover_url: item.cover } : {}) }, collab);
    await ready(id); return id;
  }
  if (item.images.length === 1) {
    const id = await container({ image_url: item.images[0], caption: item.caption }, { ...alt(0), ...collab });
    await ready(id); return id;
  }
  const children = [];
  for (const [i, url] of item.images.entries()) { const c = await container({ image_url: url, is_carousel_item: "true" }, alt(i)); await ready(c); children.push(c); }
  const id = await container({ media_type: "CAROUSEL", children: children.join(","), caption: item.caption }, collab);
  await ready(id); return id;
}

const checkId = process.argv.includes("--check") ? process.argv[process.argv.indexOf("--check") + 1] : null;
if (checkId) {
  const item = queue.find((q) => q.id === checkId);
  if (!item) { console.error(`No queued post ${checkId}`); process.exit(1); }
  const id = await build(item);
  console.log(`✓ Container ${id} for ${checkId} is ready. Not published (check only).`);
  process.exit(0);
}

const now = Date.now();
let changed = false;
for (const item of queue.sort((a, b) => a.at.localeCompare(b.at))) {
  const rec = posted[item.key] || {};
  if (rec.status === "posted" || rec.status === "missed" || (rec.status === "failed" && rec.tries >= MAX_TRIES)) continue;
  const due = Date.parse(item.at);
  if (due > now) continue;
  if (now - due > LATE_LIMIT) { posted[item.key] = { status: "missed", id: item.id, at: new Date().toISOString(), note: "more than 3 hours late; skipped" }; changed = true; continue; }
  try {
    console.log(`Posting ${item.id} (${item.type}, due ${item.at})`);
    const creation = await build(item);
    const { id: mediaId } = await call(`${IG_USER_ID}/media_publish`, { creation_id: creation });
    let permalink = null; try { permalink = (await call(mediaId, { fields: "permalink" }, "GET")).permalink; } catch {}
    posted[item.key] = { status: "posted", id: item.id, media_id: mediaId, permalink, at: new Date().toISOString() };
    console.log(`  ✓ ${permalink || mediaId}`);
  } catch (e) {
    posted[item.key] = { status: "failed", id: item.id, tries: (rec.tries || 0) + 1, error: e.message.slice(0, 300), at: new Date().toISOString() };
    console.log(`  ✗ ${e.message}`);
  }
  changed = true;
}
if (changed) writeFileSync(LOG, JSON.stringify(posted, null, 2) + "\n");
console.log(changed ? "posted.json updated" : "Nothing due.");
