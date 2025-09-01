import express from "express";
import { run, Agent, user } from "@openai/agents";
import { gatewayAgent } from "./agents"; // your defined agent
import cors from "cors";

const app = express();

app.use(cors());

app.get("/travel", async (req : any, res: any) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const query = req.query.q as string;

  const stream = await run(
    gatewayAgent,
    [user(query)],
    { stream: true }
  );

  // Send streaming tokens as SSE
  const textStream = stream.toTextStream({ compatibleWithNodeStreams: true });

  textStream.on("data", (chunk) => {
    res.write(`data: ${chunk.toString()}\n\n`);
  });

  textStream.on("end", async () => {
    await stream.completed;
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

app.listen(3000, () => console.log("API running on http://localhost:3000"));
