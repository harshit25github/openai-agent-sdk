import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {AGENT_PROMPTS} from './prompts'


// OpenAI Agents SDK
import {
  Agent,
  run,
  tool,
  user,
  assistant,
  type AgentInputItem,
} from '@openai/agents';

// ---------- Storage helpers (file-per-chat JSON) ----------
const DATA_DIR = path.join(process.cwd(), 'data', 'chats');
async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}
type ChatMessage =
  | { role: 'user'; text: string; at: string }
  | { role: 'assistant'; text: string; at: string; summary?: any };

type ChatRecord = { chatId: string; createdAt: string; messages: ChatMessage[] };

async function loadChat(chatId: string): Promise<ChatRecord> {
  await ensureDataDir();
  const file = path.join(DATA_DIR, `${chatId}.json`);
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw) as ChatRecord;
  } catch {
    const fresh: ChatRecord = {
      chatId,
      createdAt: new Date().toISOString(),
      messages: [],
    };
    await fs.writeFile(file, JSON.stringify(fresh, null, 2));
    return fresh;
  }
}

async function saveChat(rec: ChatRecord) {
  await ensureDataDir();
  const file = path.join(DATA_DIR, `${rec.chatId}.json`);
  await fs.writeFile(file, JSON.stringify(rec, null, 2));
}

// ---------- Tool schema ----------
const TripSummary = z.object({
  origin: z.object({ city: z.string(), iata: z.string().nullable().optional() }).nullable().optional(),
  destination: z.object({ city: z.string(), iata: z.string().nullable().optional() }).nullable().optional(),
  outbound_date: z.string().nullable().optional(),  // YYYY-MM-DD
  return_date: z.string().nullable().optional(),    // YYYY-MM-DD
  duration_days: z.number().int().nullable().optional(),
  pax: z.object({
    adults: z.number().int().nullable().optional(),
    children: z.array(z.number().int()).nullable().optional(),
    infants: z.number().int().nullable().optional(),
  }).nullable().optional(),
  budget: z.object({
    amount: z.number().nullable().optional(),
    currency: z.string().nullable().optional(),
    per_person: z.boolean().nullable().optional(),
  }).nullable().optional(),
  currency: z.string().nullable().optional(), // fallback if budget.currency is absent
});

const emitTripSummary = tool({
  name: 'emit_trip_summary',
  description: 'Return final trip slots (origin, destination, dates, duration, pax, budget, currency) .',
  parameters: TripSummary,
  async execute(args) {
    return args; // echo back; becomes tool result
  },
});
// ---------- Agent (put YOUR system prompt in instructions) ----------
// NOTE: You said you don’t want to add anything about the tool in the system prompt.
// We therefore *force* the tool call via modelSettings.toolChoice.
const agent = new Agent({
  name: 'Trip Planner',
  instructions: AGENT_PROMPTS.trpPromt,
  tools: [emitTripSummary],

// modelSettings: { toolChoice: 'emit_trip_summary' as const }, // ← force the tool
//   toolUseBehavior: 'run_llm_again',    
//  modelSettings: { toolChoice: 'auto' as const },
//   toolUseBehavior: 'stop_on_first_tool',
  // toolUseBehavior defaults to 'run_llm_again' (you can omit it)
  // toolUseBehavior: 'run_llm_again',
});
const extractorAgent = new Agent({
  name: 'Trip Planner (Extractor)',
  instructions: AGENT_PROMPTS.extractor,
  model: 'gpt-4.1-mini',
  outputType:TripSummary
//   tools: [emitTripSummary],
//   modelSettings: { toolChoice: 'emit_trip_summary' as const },
//   toolUseBehavior: 'stop_on_first_tool',
});

// Convert file history -> AgentInputItems
function historyToItems(history: ChatMessage[]): AgentInputItem[] {
  const items: AgentInputItem[] = [];
  for (const m of history) {
    if (m.role === 'user') items.push(user(m.text));
    if (m.role === 'assistant') items.push(assistant(m.text));
  }
  return items;
}

// ---------- Express setup ----------
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// GET: full chat history by chatId

function logEvent(ev: any) {
  const t = ev?.type;
  const name = ev?.name;
  const dataType = ev?.data?.type;
  const itemType = ev?.item?.type;
  const tool = ev?.item?.tool_name ?? ev?.item?.name;
  console.log(`[EV] type=${t} name=${name} dataType=${dataType} itemType=${itemType} tool=${tool ?? ''}`);
}
// POST: send a message, run the agent, persist both sides
// Body: { text: string }
app.post('/api/chat/:chatId/message', async (req, res) => {
  const chatId = req.params.chatId;
  const text: string = (req.body?.text ?? '').toString().trim();
  if (!text) return res.status(400).json({ error: 'Missing text' });

  const chat = await loadChat(chatId);
  chat.messages.push({ role: 'user', text, at: new Date().toISOString() });

  try {
    // ===== PASS 1: stream prose (no tools) =====
    const inputItems = historyToItems(chat.messages);
    const textStream = await run(agent, inputItems, { stream: true });

    let fullText = '';
    for await (const ev of textStream) {
      if (ev.type === 'raw_model_stream_event') {
        const data = (ev as any).data;
        if (data?.type === 'output_text_delta' || data?.type === 'response.output_text.delta') {
          fullText += data.delta ?? '';
        }
      }
    }
    await textStream.completed;

    // ===== PASS 2: extractor (forced tool -> JSON) =====
    let summary: any = null;
    const jsonStream = await run(extractorAgent, fullText);
    summary = jsonStream.finalOutput
    console.log("Final output:", summary);

    // Save and respond
    chat.messages.push({
      role: 'assistant',
      text: fullText,
      at: new Date().toISOString(),
      summary,
    });
    await saveChat(chat);

    res.json({ chatId, text: fullText, summary });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: err?.message ?? 'Unknown error' });
  }
});



// Health
app.get('/health', (_req, res) => res.json({ ok: true }));
// POST /stream — SSE over POST: text-first + summary JSON + done
app.post('/stream', async (req, res) => {
  // SSE headers (minimal)
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const textInput = (req.body?.text ?? '').toString();
  const chatId = req.body?.chatId ? String(req.body.chatId) : undefined;

  // helpers
  const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const endWithError = (err: unknown) => {
    send({ status: 'error', error: { message: String(err) } });
    try { res.end(); } catch {}
  };

  try {
    // Build inputs (use your own historyToItems/loadChat if needed; otherwise just [user(textInput)])
    let inputItems: AgentInputItem[] = [user(textInput)];
    let chatRecord: any = null;
    if (chatId && typeof loadChat === 'function' && typeof historyToItems === 'function') {
      try {
        chatRecord = await loadChat(chatId);
        chatRecord.messages.push({ role: 'user', text: textInput, at: new Date().toISOString() });
        inputItems = historyToItems(chatRecord.messages);
      } catch {}
    }

    // PASS 1 — stream prose from coreAgent (no tools)
    const streamed = await run(agent, inputItems, { stream: true });
    let full = '';
    const textStream = streamed.toTextStream({ compatibleWithNodeStreams: true });

    textStream.on('data', (chunk) => {
      const piece = chunk.toString();
      if (!piece) return;
      full += piece;

      // in-progress text packet
      send({
        status: 'in-progress',
        data: [{ type: 'text', text: piece }],
      });
    });

    textStream.on('error', (err) => endWithError(err));

    textStream.on('end', async () => {
      try { await streamed.completed; } catch {}

      // PASS 2 — extractorAgent: force emit_trip_summary, stop on tool
      let summary: any = null;
      try {
        const jstream = await run(extractorAgent, [assistant(full)], { stream: true });
        for await (const ev of jstream) {
          if (ev.type === 'run_item_stream_event') {
            const item = (ev as any).item;
            const name = (ev as any).name;
            const toolName = item?.tool_name ?? item?.name;
            if ((name === 'tool_output' || item?.type === 'tool_call_output') && toolName === 'emit_trip_summary') {
              summary = item.output;
            }
          }
        }
        await jstream.completed;
      } catch {
        summary = null;
      }

      if (summary && typeof summary === 'object' && !summary.full_text) {
        summary.full_text = full;
      }

      // one JSON "in-progress" summary packet
      if (summary) {
        send({
          status: 'in-progress',
          data: [{ type: 'summary', json: summary }],
        });
      }

      // final done packet
      send({
        status: 'done',
        data: {
          bot_message: { body: full },
          summary: summary ?? null,
        },
      });

      // optional: persist history
      if (chatRecord && typeof saveChat === 'function') {
        try {
          chatRecord.messages.push({
            role: 'assistant',
            text: full,
            at: new Date().toISOString(),
            summary: summary ?? undefined,
          });
          await saveChat(chatRecord);
        } catch {}
      }

      try { res.end(); } catch {}
    });

    // cleanup if client disconnects
    req.on('close', () => {
      try { (textStream as any).destroy?.(); } catch {}
      try { res.end(); } catch {}
    });
  } catch (err) {
    endWithError(err);
  }
});
const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, () => {
  console.log(`Server on http://localhost:${PORT}`);
});
