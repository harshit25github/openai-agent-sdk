import 'dotenv/config';
import { Agent, RunContext, run } from '@openai/agents';
import { Memory } from 'mem0ai/oss';

const mem = new Memory({
  version: 'v1.1',
  enableGraph: false,
  vectorStore: {
    provider: 'redis',
    config: {
      url: 'redis://localhost:6379/0',   // pin DB 0
      indexName: 'memories_idx_2',         // <- match your Redis index
      embeddingModelDims: 1536,
    },
  },
});

interface UserContext {
  userId: string;
  query: string;
}

async function buildInstructions(runContext: RunContext<UserContext>) {
  console.log('Searching memories for:', runContext.context.userId, 'q=', runContext.context.query);

  let memories;
  try {
    memories = await mem.search(runContext.context.query, {
      userId: runContext.context.userId,
    });
    console.log('mem.search ok:', memories);
  } catch (e) {
    console.error('mem.search error:', e);
    memories = { results: [] };
  }

  const memStr = (memories.results ?? []).map((m: any) => m.memory).join('\n');

  return `
    You are a friendly assistant.
    Context about user (from memory):
    ${memStr || 'No relevant past info'}
  `;
}

const agent = new Agent<UserContext>({
  name: 'MemoryAwareAgent',
  instructions: buildInstructions,
});

async function runChat(userId: string, query: string) {
  // @ts-ignore: run helper executes the agent
  const result = await run(agent, query, { context: { userId, query } });

  const reply: string = result.finalOutput || 'agent response missing';
  console.log(`User: ${query}`);
  console.log(`Agent: ${reply}`);

  try {
    await mem.add(
      [
        { role: 'user', content: query },
        { role: 'assistant', content: reply },
      ],
      { userId }
    );
    console.log('mem.add ok');
  } catch (e) {
    console.error('mem.add error:', e);
  }
}
function generateRandom10DigitNumber() {
  // Define the minimum and maximum values for a 10-digit number.
  const min = 1000000000; // Smallest 10-digit number
  const max = 9999999999; // Largest 10-digit number
  return `${Math.floor(Math.random() * (max - min + 1)) + min}`;
}
(async () => {
    const idx  = generateRandom10DigitNumber();
  await runChat( idx, 'My name is Sam and I live in New York. I love hiking and photography.');

  await new Promise((r) => setTimeout(r, 4000));
  await runChat(idx, 'what is the old memory u have about me?');
})();
