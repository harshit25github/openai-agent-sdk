import 'dotenv/config';
import { Agent, RunContext, run } from '@openai/agents';
import { Memory } from 'mem0ai/oss';

const mem = new Memory({
  version: 'v1.1',
  enableGraph: false,

  // Optional (mem0 can also read OPENAI_API_KEY directly)
  embedder: {
    provider: 'openai',
    config: { apiKey: process.env.OPENAI_API_KEY!, model: 'text-embedding-3-small' }, // 1536 dims
  },

  // ✅ Use mem0's Redis keys exactly as documented
  vectorStore: {
    provider: 'redis',
    config: {
      collection_name: 'mem0',                 // any name you want for this "collection"
      embedding_model_dims: 1536,              // MUST be present (and correct for your embed model)
      redis_url: 'redis://localhost:6379/0',   // pin DB if you want; /0 is default DB
    },
  },
});



interface UserContext {
  userId: string;      // use chatId here if that’s your namespace
  query: string;
}

async function buildInstructions(runContext: RunContext<UserContext>) {
  const { userId, query } = runContext.context;

  let memStr = '• (no relevant past info)';
  try {
    const r = await mem.search(query, { userId });
    const lines = (r.results ?? [])
      .sort((a: any, b: any) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 3)
      .map((m: any) => `• ${m.memory}`);
    if (lines.length) memStr = lines.join('\n');
  } catch (e) {
    console.error('mem.search error:', e);
  }

  return `
You are a friendly assistant. Use the memory context when relevant.

Memory context:
${memStr}
`;
}

const agent = new Agent<UserContext>({
  name: 'MemoryAwareAgent',
  model: 'gpt-4.1-mini',
  instructions: buildInstructions,
});

// keep writes small & distinct to avoid dedupe
function atomicMemories(userQ: string, assistantA: string) {
  const shortA = assistantA.length > 160 ? assistantA.slice(0, 160) + '…' : assistantA;
  return [
    { role: 'user', content: `User intent: ${userQ}` },
    { role: 'assistant', content: `Answer summary: ${shortA}` },
  ];
}

async function runChat(userId: string, query: string) {
  // @ts-ignore
  const result = await run(agent, query, { context: { userId, query } });
  const reply: string = result.finalOutput || '(no reply)';
  console.log(`User: ${query}`);
  console.log(`Agent: ${reply}`);

  // write memories
  try {
    const saved = await mem.add(atomicMemories(query, reply), { userId, metadata: { userId } });
    console.log('mem.add saved count:', saved?.results?.length ?? 0);

    const all = await mem.getAll({ userId });
    console.log('total docs for this userId:', all.results?.length ?? 0);
  } catch (e) {
    console.error('mem.add error:', e);
  }
}

// demo: one chat with two turns (same ID ==> same namespace)
(async () => {
  const chatId = `${Math.floor(1000000000 + Math.random() * 9000000000)}`;
  await runChat(chatId, 'Suggest me some books?');
  await new Promise(r => setTimeout(r, 1000));
  await runChat(chatId, 'what is the old memory u have about me?');
})();
