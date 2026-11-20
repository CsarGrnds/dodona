// npm run notify:test: sends one test iMessage to DODONA_IMESSAGE_TO (.env.local), the way Dodona sends
// "batch ready" alerts. The first time, macOS asks to let Terminal (or Dodona's Node) control Messages.
import { imessageTo, notifyIMessage } from "../lib/data/liveRun";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* no .env.local */
}
async function main() {
  const to = imessageTo();
  const err = await notifyIMessage("Dodona: phone test. Batch alerts will arrive like this. Nothing is staged, no action needed.");
  if (err) {
    console.error(`NOT SENT: ${err}`);
    process.exit(1);
  }
  console.log(`SENT to ${to?.includes("@") ? to.replace(/^(.).*@/, "$1…@") : `…${to?.slice(-4)}`}`);
}
void main();
