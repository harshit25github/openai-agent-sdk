// travel-multiagents-min.ts
import 'dotenv/config';
import { Agent, handoff, run, webSearchTool } from '@openai/agents';
import { RECOMMENDED_PROMPT_PREFIX } from '@openai/agents-core/extensions';
import fs from 'fs';

/** 1) Minimal shared “slot” shape for orchestration (purely local to your app). */
type Slots = {
  destination?: string;        // e.g., "Bali"
  destinationVerified?: boolean;
  pax?: number;
  itineraryFinalized?: boolean;
};

/** 2) Destination Agent — finalizes destination + gives safety/visa insights. */
const destinationAgent = new Agent({
  name: 'Destination Agent',
  instructions: `
You help finalize the user's destination and provide essential insights:
- Disambiguate locations if ambiguous.
- Give safety advisories (high-level) using web_search tool .
- Call out visa updated requirements plainly using web_search .
- End your reply with a crisp "DESTINATION_CONFIRMED: <city/country>" line once confident.
`,
tools:[webSearchTool()],
});

/** 3) Itinerary Agent — can call Destination internally if checks are missing. */
const destinationTool = destinationAgent.asTool({
  toolName: 'verify_destination',
  toolDescription: 'Validate/confirm destination and return safety/visa essentials before planning.',
});

const itineraryAgent = new Agent({
  name: 'Itinerary Agent',
  tools: [destinationTool],
  instructions: `
You create a clear, day-wise itinerary (morning/afternoon/evening) tailored to pax & dates.

If the destination isn't clearly verified (visa/safety unknown) OR the user jumped straight to planning,
FIRST call the tool 'verify_destination' with the user's intended place. Then plan.

Output format:
- Brief confirmation line about destination checks.
- Then a 3–5 day outline with time-of-day blocks.
- Keep it concise and actionable.
`,
});

/** 4) Booking Agent — assume it receives a finalized itinerary. */
const bookingAgent = new Agent({
  name: 'Booking Agent',
  instructions: `
You assist in booking flights/hotels AFTER the itinerary is finalized.
If anything is missing (no destination, dates, or itinerary), ask for that first.
Provide a simple checklist and a ready-to-book summary.
`,
});

/** 5) Gateway (Orchestrator) — uses handoffs to route phases. */
const gatewayAgent = Agent.create({
  name: 'Gateway (Triage) Agent',
  handoffs: [
    handoff(destinationAgent),
    handoff(itineraryAgent),
    handoff(bookingAgent),
  ],
  instructions: `${RECOMMENDED_PROMPT_PREFIX}
You orchestrate the travel flow. Internally decide when to hand off:

- If the user is CHOOSING or VERIFYING a destination → hand off to Destination Agent.
- If the user requests an ITINERARY and destination seems chosen → hand off to Itinerary Agent.
- If the user wants to BOOK and itinerary looks done → hand off to Booking Agent.
- If the user skips steps (e.g., asks itinerary without destination verification),
  you MAY still hand off to Itinerary Agent; Itinerary will internally call Destination as a tool
  to backfill visa/safety checks (keep this invisible to the user).

Be brief, keep tone consistent, and never expose internal routing.
`,
});

/** 6) A tiny runner demonstrating two user journeys. */
async function demo() {
  // Local run-scoped state you can mutate in tools/callbacks if needed.
  const slots: Slots = { pax: 2 };

  // A) User jumps straight to itinerary (destination not pre-verified).
  const resultA = await run(
    gatewayAgent,
    `Plan a 5-day trip for 2 adults to Bali in November. Focus on beaches + culture.`,
    { context: slots } // (Optional) pass dependencies/state your tools may use
  );
  console.log('--- A) Jumped-to-Itinerary path (Itinerary internally verifies destination) ---');
   fs.writeFileSync('resultA.json', JSON.stringify(resultA, null, 2));
  console.log(resultA.finalOutput);

  // B) Normal path: user first asks for destination help, then asks itinerary, then booking.
  // const resultB1 = await run(
  //   gatewayAgent,
  //   `I’m torn between Tokyo or Kyoto for 5 days. Which should I pick and why?`,
  //   { context: slots }
  // );
  // console.log('\n--- B1) Destination triage/decision ---');
  // console.log(resultB1.finalOutput);
  // fs.writeFileSync('resultB1.json', JSON.stringify(resultB1, null, 2));

  // const resultB2 = await run(
  //   gatewayAgent,
  //   `Great, please create a detailed 5-day itinerary for the chosen place.`,
  //   { context: slots }
  // );
  // console.log('\n--- B2) Itinerary after destination settled ---');
  // console.log(resultB2.finalOutput);
  // fs.writeFileSync('resultB2.json', JSON.stringify(resultB2, null, 2));
  // const resultB3 = await run(
  //   gatewayAgent,
  //   `Looks good. Help me book this trip — flights + a mid-range hotel.`,
  //   { context: slots }
  // );
  // console.log('\n--- B3) Booking after itinerary finalized ---');
  // console.log(resultB3.finalOutput);
  // fs.writeFileSync('resultB3.json', JSON.stringify(resultB3, null, 2));
  }

demo().catch(console.error);
