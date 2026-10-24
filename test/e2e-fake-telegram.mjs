// Fake Telegram Bot API: getUpdates queue, sendMessage log, and test hooks /_push and /_sent.
import http from "node:http";
const port = Number(process.env.FAKE_TG_PORT ?? 9913);
const queue = [];
const sent = [];
http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", async () => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/_push") { queue.push(JSON.parse(b)); return res.end("{}"); }
    if (req.url === "/_sent") return res.end(JSON.stringify(sent));
    if (/\/getUpdates/.test(req.url)) {
      if (!queue.length) await new Promise((r) => setTimeout(r, 400));
      return res.end(JSON.stringify({ ok: true, result: queue.splice(0) }));
    }
    if (/\/sendMessage/.test(req.url)) { sent.push(JSON.parse(b)); return res.end('{"ok":true}'); }
    res.statusCode = 404; res.end("{}");
  });
}).listen(port, "127.0.0.1", () => console.log("fake telegram on", port));
