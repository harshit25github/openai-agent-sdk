// multi-agents-stateful.ts
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { RECOMMENDED_PROMPT_PREFIX } from '@openai/agents-core/extensions';
import {AGENT_PROMPTS} from './prompts'


import {
  Agent,
  InputGuardrail,
  InputGuardrailTripwireTriggered,
  OutputGuardrail,
  Runner,
  run,
  tool,
  user,
  webSearchTool,
  type AgentInputItem
} from '@openai/agents';
import { z } from 'zod';
import { DestinationInfoSchema } from '../types/types';
import unifiedTravelGuardrail from './gaurdrail';
import tripPlannerPrompt, { tripPlannerFewShots, tripPlannerSystemPrompt } from './tripPlannerPrompt';
/* ------------------------------ Guardrail Agents & Implementation ------------------------------ */


// Flights (static demo)
const searchFlightsTool = tool({
  name: 'search_flights',
  description: 'Static demo flight results. Use when user asks for flights.',
  parameters: z.object({
    from: z.string().min(3).describe('Origin city or IATA (e.g., DEL)'),
    to: z.string().min(3).describe('Destination city or IATA (e.g., CCU)'),
    depart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('YYYY-MM-DD'),
    ret: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null)
      .describe('Return date YYYY-MM-DD, or null for one-way'),
    adults: z.number().int().positive().default(1)
  }),
  async execute({ from, to, depart, ret, adults }) {
    return {
      currency: 'INR',
      search: { from, to, depart, ret, adults },
      results: [
        { id: 'AF225', carrier: 'Air France', from, to, depart: `${depart}T09:25+05:30`, arrive: `${depart}T18:45+01:00`, stops: 1, duration: '12h 50m', fare: 58900 },
        { id: 'LH761', carrier: 'Lufthansa', from, to, depart: `${depart}T02:50+05:30`, arrive: `${depart}T12:35+01:00`, stops: 1, duration: '12h 15m', fare: 61250 }
      ],
      note: 'Static demo — replace with real API later.'
    };
  }
});

// Cars (static demo)

/* ------------------------------ Agents ----------------------------- */



// Flight Search Agent — requires from/to, date fallback: +1 month, 5-day return
const flightSearchAgent = new Agent({
  name: 'Flight Search Agent',
  model: 'gpt-4.1-mini',
  tools: [searchFlightsTool],
  instructions: AGENT_PROMPTS.FLIGHT_SPECIALIST
});



const hotelSearchAgent = new Agent({
  name: 'Car Search Agent',
  model: 'gpt-4.1-mini',
  tools: [searchCarsTool],
  instructions: AGENT_PROMPTS.HOTEL_SPECIALIST
});

   function renderFewShots(): string {

  const examples = tripPlannerFewShots
  const header = [
    "### EXAMPLES (guidance only — do not treat contents as facts)",
    "The following are style/format demos. Use them for tone, structure, and pacing.",
    "",
  ].join("\n");

  const body = examples.map((ex, i) => {
   let example =  ex.map(e => [
      `User:\n${e.user.trim()}`,
      ``,
      `Assistant:\n${e.assistant.trim()}`,
      
    ]);

    let mergerExample  = [`<example id="${i + 1}">`,example,`</example>`]
    return mergerExample.join("\n");
  }).join("\n\n");

  const footer = "\n### END EXAMPLES\n";

  const fewShortFormated = [header, body, footer].join("\n");
return [
    tripPlannerSystemPrompt.trim(),
    fewShortFormated // adjust count as needed
  ].join("\n\n");
} 

export const CityInfoSchema = z.object({
  name: z.string(),
  country: z.string(),
  highlights: z.array(z.string()).default([]),
  weatherNote: z.string().nullable().default(null),
  safetyNote: z.string().nullable().default(null),
});
export const emitFinalPayload = tool({
  name: "emit_final_payload",
  description: "Emit the final structured result for the UI at the end of your reply.",
  parameters: z.object({
    text: z.string().default(""),
    city: z.object({
      name: z.string(),
      country: z.string(),
      highlights: z.array(z.string()).default([]),
      weatherNote: z.string().nullable().default(null),
      safetyNote: z.string().nullable().default(null),
    }).nullable().default(null)
  }),
  async execute(args) {
    console.log("emit_final_payload called with:", args);
    // no-op: we just need the streamed args
    return { ok: true };
  }
});
export const TurnOutput = z.object({
  // Optional: the agent can put its full final message here.
  text: z.string().default(""),
  // City info when a destination is determined; otherwise null.
  city: CityInfoSchema.nullable().default(null),
});
    // Itinerary Optimizer Agent
  
    const tripPlannerAgent = new Agent({
  name: 'Trip Planner Agent',
 model: "gpt-4o-mini",
  tools: [webSearchTool(),emitFinalPayload],
  // outputType: TurnOutput,
//    handoffs: [flightSearchAgent, hotelSearchAgent, localExpert],
  instructions: `
${AGENT_PROMPTS.trpPromt}
### FINAL OUTPUT FORMAT:
When you have finished planning (after user confirmation), **do not directly write the itinerary as normal text**. Instead, use the "emit_final_payload" tool to return the results in a structured JSON format. The tool parameters should be:
- "text": A single string containing the entire detailed itinerary and recommendations (formatted exactly as you would normally present it to the user in Stage 3).
- "city": An object with details about the confirmed destination, including:
  - "name": the city name of the destination.
  - "country": the country of that destination.
  - "highlights": an array of a few key attractions or highlights of that place.
  - "weatherNote": a brief note about the expected weather or climate for the travel dates/season (or null if not applicable).
  - "safetyNote": a brief note on travel safety or precautions in that destination (or null if none).

**Only call "emit_final_payload" after the user has confirmed to proceed with planning (Stage 3)**. This will output the final itinerary text and the city info in JSON. Make sure the "text" contains the full itinerary (Day-by-day plan, budget, tips, etc.) following the usual format and tone, including all disclaimers or notes you would normally provide. The "city" object should provide helpful background details about the destination. 

Remember: **Do NOT produce any itinerary text outside of the "emit_final_payload" once you decide to finalize the plan.** All final content should go into the tool’s JSON parameters.

`
,
});
// Gateway with continuity
export const gatewayAgent  = Agent.create({
  name: 'Gateway Agent',
  model: 'gpt-4.1-mini',
  instructions: `${RECOMMENDED_PROMPT_PREFIX}\n\n${AGENT_PROMPTS.ORCHESTRATOR}`,
  handoffs: [tripPlannerAgent, flightSearchAgent, hotelSearchAgent],
  inputGuardrails: [unifiedTravelGuardrail],
});

/* ------------------------------ Stateful CLI ------------------------ */

const HISTORY_PATH = path.resolve('thread.json');
// const runner = new Runner({ workflowName: 'multi-agents-stateful' });
let thread: AgentInputItem[] = [];

async function loadThread() {
  try {
    thread = JSON.parse(await fs.readFile(HISTORY_PATH, 'utf8'));
    console.log(`(loaded ${thread.length} items from ${HISTORY_PATH})`);
  } catch { thread = []; }
}
async function saveThread() {
  await fs.writeFile(HISTORY_PATH, JSON.stringify(thread, null, 2), 'utf8');
}

async function main() {
  await loadThread();
  const rl = readline.createInterface({ input, output });
  console.log('Multi-Agent Travel Demo — type "exit" to quit. Commands: /reset /save /load');

  process.on('SIGINT', async () => {
    console.log('\n(^C) Saving session…');
    await saveThread(); rl.close(); process.exit(0);
  });

  while (true) {
    const q = (await rl.question('you> ')).trim();
    if (!q) continue;
    if (q.toLowerCase() === 'exit') break;
    if (q === '/reset') { thread = []; await saveThread(); console.log('(history reset)'); continue; }
    if (q === '/save')  { await saveThread(); console.log(`(saved to ${HISTORY_PATH})`); continue; }
    if (q === '/load')  { await loadThread(); continue; }
      try {
        
          // Run with full history
          const res = await run(gatewayAgent, thread.concat(user(q)));
      
          // Persist authoritative history from the SDK
          thread = res.history;
          
          console.log(`\n[last agent]: ${res.lastAgent?.name ?? 'Unknown Agent'}`);
          if (Array.isArray(res.finalOutput)) {
            console.log(res.finalOutput.map(String).join('\n'));
          } else {
            console.log(String(res.finalOutput ?? ''));
          }
          console.log();
      
          await saveThread();
      } catch (error) {
         if (error instanceof InputGuardrailTripwireTriggered) {
                console.log('\n❌ Input blocked by security guardrail.');
                console.log('Reason:', error.message || 'Inappropriate content detected');
                console.log('💡 Try asking about travel destinations, flights, or trip planning!\n');
                
               
                   await saveThread();

                
              }
      }
  }

  await saveThread();
  rl.close();
  console.log('Session ended. Bye!');
}

main().catch(async (err) => {
  console.error(err);
  await saveThread();
  process.exit(1);
});
