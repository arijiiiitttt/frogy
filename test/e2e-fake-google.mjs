// Fake Google token + Gmail server for the e2e script. Prints each "sent" message's headers.
import http from "node:http";
const port = Number(process.env.FAKE_PORT ?? 9911);
let n = 0;
http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c));
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/token") return res.end(JSON.stringify({ access_token: "ya29.fake", expires_in: 3600 }));
    if (req.url?.startsWith("/gmail/v1/users/me/messages/send")) {
      const raw = Buffer.from(JSON.parse(b).raw, "base64url").toString();
      console.log("FAKE-GMAIL received:", raw.split("\r\n").slice(0, 2).join(" | "));
      return res.end(JSON.stringify({ id: `msg${++n}`, threadId: "t" }));
    }
    res.statusCode = 404; res.end("{}");
  });
}).listen(port, "127.0.0.1", () => console.log("fake google on", port));
