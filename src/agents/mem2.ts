import 'dotenv/config';
import { Agent, RunContext, run } from '@openai/agents';
import { Memory } from 'mem0ai/oss';

const mem = new Memory({
  version: 'v1.1',
  enableGraph: false,
  vectorStore: {
    provider: 'redis',
    config: {
      url: 'redis://localhost:6379/0',
      collectionName: 'memories_idx_1',  // CHANGE: indexName -> collectionName
      dimension: 1536,                   // CHANGE: embeddingModelDims -> dimension
    },
  },
  embedder: {                           // ADD: Required embedder config
    provider: 'openai',
    config: {
      apiKey: process.env.OPENAI_API_KEY,
      model: 'text-embedding-3-small',
      
    }
  },
  llm: {                               // ADD: Required llm config
    provider: 'openai',
    config: {
      apiKey: process.env.OPENAI_API_KEY,
      model: 'gpt-4o-mini'
    }
  }
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
    // CHANGE: Save as single string instead of array
    await mem.add(
      `User: ${query} | Assistant: ${reply}`,
      { userId }
    );
    console.log('mem.add ok');
  } catch (e) {
    console.error('mem.add error:', e);
  }
}

function generateRandom10DigitNumber() {
  const min = 1000000000;
  const max = 9999999999;
  return `${Math.floor(Math.random() * (max - min + 1)) + min}`;
}

(async () => {
  const idx = generateRandom10DigitNumber();
  await runChat(idx, 'Suggest me some books?');

  await new Promise((r) => setTimeout(r, 4000));
  await runChat(idx, 'Remind me what I asked earlier.');
})();