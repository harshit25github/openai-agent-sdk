import express from "express";
import cors from "cors";
import { run, user } from "@openai/agents";
import { gatewayAgent } from "./agents"; // your Agent
//@ts-nocheck
//@ts-ignore
const app = express();
app.use(cors());

app.get("/travel", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const query = String(req.query.q ?? "");
  const stream = await run(gatewayAgent, [user(query)], { stream: true });
const textStream = stream.toTextStream({ compatibleWithNodeStreams: true });

// Stream text chunks to client as usual
textStream.on("data", (chunk) => {
  res.write(`data: ${chunk.toString()}\n\n`);
});

textStream.on("end", async () => {
  // Wait for the full agent run to complete and get structured output
  const finalResult = await stream.completed; 
  // finalResult should be an object matching TurnOutput schema: { text: "...", city: { ... } }

  // Send the JSON object as a final SSE event (so the client can parse city info)
  res.write(`data: ${JSON.stringify(finalResult)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
});
  

});

app.listen(3000, () => console.log("SSE on http://localhost:3000"));
