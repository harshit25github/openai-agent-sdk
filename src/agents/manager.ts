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
  RunContext,
  Runner,
  handoff,
  run,
  system,
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



const DESTINATION_DECIDER_PROMPT = `
You are **DestinationDecider** for cheapoair.ai.
Goal: help the user PICK a destination based primarily on **interests/vibe**. 
- Do: compare 2–4 options (Fit Score 0–100), 1-line rationale, seasonality note, indicative budget band (per-person + total in INR if unclear), and typical flight time from origin **if origin is known**.
- Don’t: write day-wise itineraries, visa/policy advice, or book anything.
- Ask at most ONE clarifying question if interests are vague. Interests are the ONLY required input.
- If user already has a destination, yield immediately to ItineraryBuilder.
- When user chooses a destination, explicitly ask: “Proceed to build a day-wise itinerary?” and then call ItineraryBuilder as a tool with whatever slots you have.

Normalization (internal; don’t over-ask):
- If dates are vague, keep a month window (YYYY-MM).
- If origin is unknown, omit flight times; don't force it.
- Currency: INR default; timezone: Asia/Kolkata.

Output structure:
1) Short acknowledgement
2) Ranked shortlist (2–4): {Destination, FitScore, Why, Seasonality, IndicativeCost, FlightTime?}
3) Clear next step: “Pick one” or “tweak vibe”. If picked → call ItineraryBuilder tool.
`;

const ITINERARY_BUILDER_PROMPT =`
You are **ItineraryBuilder** for cheapoair.ai.
Goal: produce a **day-wise itinerary** (Morning / Afternoon / Evening), with commute notes, alternates/rainy-day options, and a budget snapshot (per-person + total in user currency, INR default).

Absolute rules:
1) Do NOT produce any itinerary until all criticals are confirmed: origin, destination, outbound_date & inbound_date (or nights), pax. If a budget is mentioned, clarify if per-person or total.
2) Ask once for missing criticals (natural language). If complete, summarize and ask: “Proceed with the detailed plan?” Only then output the plan.
3) If user re-enters “discovery mode” (e.g., asks “Bali or Phuket?”), call DestinationDecider as a tool.

Planning checklist (internal):
- Dates (Asia/Kolkata): future only; inbound ≥ outbound. Nights = date diff.
- Cluster by neighborhoods to minimize transit.
- For each day: Morning / Afternoon / Evening + commute tip.
- Budget snapshot: ranges + rough split: Accom (~40%), Transport (~30%), Food&Activities (~30%).
- Tone: warm, concise, optimistic.

Output stages:
- Stage 1 (Gather): ask for missing criticals.
- Stage 2 (Confirm): slots summary + explicit “Proceed?”
- Stage 3 (Plan): Day-by-day; tips; budget; next actions (search flights/hotels, key attraction prebooks).
`;
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
const EmptyPayload = z.object({});
type EmptyPayload = z.infer<typeof EmptyPayload>;
    // Itinerary Optimizer Agent
export const destinationDecider = new Agent<EmptyPayload>({
  name: 'DestinationDecider',
  instructions: DESTINATION_DECIDER_PROMPT,
  // You can add hosted tools later (web search, file search) if you like:
  tools: [webSearchTool()],  // optional
});

export const itineraryBuilder = new Agent<EmptyPayload>({
  name: 'ItineraryBuilder',
  instructions: ITINERARY_BUILDER_PROMPT,
});

// -----------------------------
// 3) Expose each agent as a tool for the other
//    (Agents-as-tools API: agent.asTool({ toolName, toolDescription }))
//    Ref: OpenAI Agents SDK "Tools → 3. Agents as tools" guide.
// -----------------------------

const itineraryToolForDestination = itineraryBuilder.asTool({
  toolName: 'itinerary_builder.plan',
  toolDescription:
    'Create a day-wise itinerary after a destination has been selected. Use only when the user is ready to plan.',
});

const destinationToolForItinerary = destinationDecider.asTool({
  toolName: 'destination_decider.suggest',
  toolDescription:
    'Suggest and compare destinations when the user is still deciding. Use when destination is unclear or user asks for comparisons.',
});

destinationDecider.tools = [...(destinationDecider.tools ?? []), itineraryToolForDestination];
itineraryBuilder.tools = [...(itineraryBuilder.tools ?? []), destinationToolForItinerary];
// Gateway with continuity


function onHandoff(ctx: RunContext) {
  console.log('Handoff called for agent: destination decider', 'with context:', ctx.context);
}
function onHandoffItenary(ctx: RunContext) {
  console.log('Handoff called for agent: itenary builder', 'with context:', ctx.context);
}

export const gatewayAgent  = Agent.create({
  name: 'Gateway Agent',
  model: 'gpt-5-mini',
  instructions: `${RECOMMENDED_PROMPT_PREFIX}\n\n${AGENT_PROMPTS.managerORCHESTRATOR}`,
  handoffs: [handoff(destinationDecider,{onHandoff, inputType: EmptyPayload}), handoff(itineraryBuilder,{onHandoff:onHandoffItenary, inputType: EmptyPayload})],
  inputGuardrails: [unifiedTravelGuardrail],
});

/* ------------------------------ Stateful CLI ------------------------ */

const HISTORY_PATH = path.resolve('thread2.json');
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
