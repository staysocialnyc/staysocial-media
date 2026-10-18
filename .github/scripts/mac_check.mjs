// Backup alarm. The Mac records each finished step in status/mac.json (scripts/status_beat.mjs on the Mac). This job runs
// on GitHub (so it works when the Mac is closed) and emails the Stay Social inbox, through iContact's one-person TEST list,
// when an expected step is missing. Each alert is sent once (status/alerts.json).
//   node .github/scripts/mac_check.mjs            # check now
//   node .github/scripts/mac_check.mjs --test     # send a test alert
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

const env = process.env;
const readJ = (p, fb) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fb);
const status = readJ("status/mac.json", {});
const sent = readJ("status/alerts.json", {});
const has = (k) => status[k]?.value;

// New York clock.
const ny = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const tomorrow = ymd(new Date(ny.getFullYear(), ny.getMonth(), ny.getDate() + 1));
const mins = ny.getHours() * 60 + ny.getMinutes();
const at = (h, m) => mins >= h * 60 + m;
const nice = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

const alerts = [];
const plus = (n) => ymd(new Date(ny.getFullYear(), ny.getMonth(), ny.getDate() + n));
if (ny.getDay() === 1) { // Monday: research for Thursday's issue (runs 10 AM, retries 11 AM and noon)
  const i = plus(3);
  if (at(13, 0) && !has(`nl:${i}:research`)) alerts.push([`nl:${i}:no_research`, `Monday research for the ${nice(i)} newsletter did NOT finish`, `The Mac didn't research events for Thursday's issue (it was closed, offline, or Claude's login expired). Open the Mac and message Claude: "run Monday research for ${nice(i)}". Picks are due Wednesday 11 AM.`]);
}
if (ny.getDay() === 2) { // Tuesday: promoter submissions + "picks are ready" text (12:05 PM, retries 12:35 and 1:05)
  const i = plus(2);
  if (at(13, 30) && !has(`nl:${i}:load`)) alerts.push([`nl:${i}:no_load`, `Tuesday's picks load for the ${nice(i)} newsletter did NOT run`, `Promoter submissions weren't pulled and nobody was texted the picks page. Open the Mac and message Claude: "run Tuesday's load for ${nice(i)}".`]);
}
if (ny.getDay() === 3) { // Wednesday: tomorrow's newsletter
  const i = tomorrow, d = has(`nl:${i}:deadline`);
  if (at(11, 45) && !d) alerts.push([`nl:${i}:no_deadline`, `The Mac did NOT run the 11 AM picks deadline for the ${nice(i)} newsletter`, `The final newsletter hasn't been built, so nobody has been asked for final approval. The Mac is probably closed, asleep or offline. Open it (plugged in, online) and message Claude: "build the ${nice(i)} newsletter". Final approval is due 3:30 PM.`]);
  else if (at(12, 30) && d === "BUILD" && !has(`nl:${i}:final_built`)) alerts.push([`nl:${i}:no_final`, `The ${nice(i)} newsletter build started but didn't finish`, `Picks were in, but the final newsletter wasn't built. Open the Mac and message Claude: "check the ${nice(i)} newsletter build".`]);
  if (at(16, 15) && d !== "NO_SUBMISSION" && !has(`nl:${i}:scheduled`) && !has(`nl:${i}:final_deadline`)) alerts.push([`nl:${i}:not_scheduled`, `The ${nice(i)} newsletter is NOT scheduled`, `By 4:15 PM the Mac had not scheduled tomorrow's 8 AM send or recorded a decision. If you approved it, it has not been sent to iContact. Open the Mac and message Claude: "send the ${nice(i)} newsletter".`]);
}
if (ny.getDay() === 0) { // Sunday: next week's Instagram (week starts tomorrow)
  const m = tomorrow;
  if (at(11, 45) && !has(`ig:${m}:drafted`)) alerts.push([`ig:${m}:no_draft`, `Next week's Instagram (from ${nice(m)}) was NOT drafted`, `The Sunday draft didn't finish, so there's nothing to approve yet. Open the Mac and message Claude: "draft this week's Instagram". Approval is due 3:30 PM.`]);
  if (at(16, 15) && has(`ig:${m}:drafted`) !== "not_connected" && !has(`ig:${m}:deadline`)) alerts.push([`ig:${m}:no_deadline`, `Instagram for the week of ${nice(m)} is NOT queued`, `By 4:15 PM the Mac had not processed the Instagram approval, so nothing is queued to post from Monday 9 AM. Open the Mac and message Claude: "queue this week's Instagram".`]);
}
if (process.argv.includes("--test")) alerts.push([`test:${Date.now()}`, "Test alert: the backup alarm works", "This is a test of the Stay Social backup alarm. Real alerts look like this and arrive when the Mac misses a newsletter or Instagram step."]);

const todo = alerts.filter(([key]) => !sent[key]);
if (!todo.length) { console.log(`Nothing to alert (${ny.toLocaleString("en-US")} New York).`); process.exit(0); }

const base = `${env.ICONTACT_API_URL}/a/${env.ICONTACT_ACCOUNT_ID}/c/${env.ICONTACT_CLIENT_FOLDER_ID}`;
const headers = { Accept: "application/json", "Content-Type": "application/json", "Api-Version": "2.2", "Api-AppId": env.ICONTACT_APP_ID, "Api-Username": env.ICONTACT_USERNAME, "Api-Password": env.ICONTACT_API_PASSWORD };
const post = async (path, body) => { const r = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) }); const j = await r.json().catch(() => ({})); if (!r.ok || j.errors?.length) throw new Error(`${path} → HTTP ${r.status} ${JSON.stringify(j.errors || j).slice(0, 200)}`); return j; };
let failed = false;
for (const [key, subject, body] of todo) {
  try {
    const { messages = [] } = await post("/messages", [{ campaignId: env.ICONTACT_CAMPAIGN_ID, messageType: "normal", messageName: `ALERT ${key}`, subject: `⚠ Stay Social: ${subject}`,
      htmlBody: `<div style="font:16px/1.5 Helvetica,Arial,sans-serif;max-width:560px;margin:auto;padding:20px"><h2 style="color:#BE123C;margin:0 0 12px">${subject}</h2><p>${body}</p><p style="color:#666;font-size:13px">Sent by the Stay Social backup alarm on GitHub, ${ny.toLocaleString("en-US")} New York time.</p></div>`,
      textBody: `${subject}\n\n${body}\n\n(Stay Social backup alarm, ${ny.toLocaleString("en-US")} New York time)` }]);
    await post("/sends", [{ messageId: messages[0].messageId, includeListIds: env.ICONTACT_ALERT_LIST_ID }]);
    sent[key] = new Date().toISOString();
    console.log(`✓ alert sent: ${subject}`);
  } catch (e) { failed = true; console.log(`✗ couldn't send "${subject}": ${e.message}`); }
}
mkdirSync("status", { recursive: true });
writeFileSync("status/alerts.json", JSON.stringify(sent, null, 2) + "\n");
if (failed) process.exit(1); // a failed run also triggers GitHub's own failure email
