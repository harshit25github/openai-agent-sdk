// server.ts
import express from "express";
import cors from "cors";
import { run, user } from "@openai/agents";
import { gatewayAgent } from "./agents"; // your existing agent

const app = express();
app.use(cors());

app.get("/stream", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const q = String(req.query.q ?? "");
  let full = "";
  // Start a streamed run
  const streamed = await run(gatewayAgent, [user(q)], { stream: true });

  // This is an incremental text stream (fresh tokens only)
  const textStream = streamed.toTextStream({ compatibleWithNodeStreams: true });

    const send = (obj: unknown) => {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  textStream.on("data", (chunk) => {
    const piece = chunk.toString();
    if (!piece) return;
    full += piece;

    // Mindtrip-style "in-progress" packet
    send({
      status: "in-progress",
      data: [{ type: "text", text: piece }],
    });
  });

  textStream.on("end", async () => {
    // ensure agent run has fully settled (optional but nice)
    try { await streamed.completed; } catch {}

    // Mindtrip-style "done" packet with full body
    send({
      status: "done",
      data: {
        bot_message: {
          body: full,
        },
      },
    });

    res.end();
  });

  textStream.on("error", (err) => {
    send({
      status: "error",
      error: { message: String(err) },
    });
    res.end();
  });

  // Cleanup if client disconnects
  req.on("close", () => {
    try { (textStream as any).destroy?.(); } catch {}
  });
});

app.listen(3000, () =>
  console.log("SSE ready at http://localhost:3000/stream")
);
