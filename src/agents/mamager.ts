import 'dotenv/config';
import { Agent, RunContext, run, tool, user } from '@openai/agents';
import { RECOMMENDED_PROMPT_PREFIX } from '@openai/agents-core/extensions';
import { z } from 'zod';

// Minimal manager-mode setup using agents-as-tools
// Manager routes to three specialists: Destination, Itinerary, Booking

const MANAGER_PROMPT = `
You are the Manager Agent. Your only job is to route the user's request to the correct specialist by calling a tool.

Routing rules (deterministic):
- If the user is deciding where to go (interests, vibe, comparisons) → call transfer_to_destination_decider.
- If the user already has a destination and wants a plan/itinerary → call transfer_to_itinerary_planner.
- If the user asks to book flights/hotels or finalize reservations → call transfer_to_booking_agent.

Behavior:
- Keep your surface text short and warm (one-liners). Do not produce any travel content yourself.
- Immediately call exactly one tool once intent is clear. If intent is unclear, ask a single clarifying question.
`;

const DESTINATION_DECIDER_PROMPT = `
You are Destination Decider. Help the user choose a destination based on their vibe, interests, and constraints.
Do:
- Present 2–3 strong options with one-line rationale and seasonal note.
- If origin and rough dates are known, mention typical flight time band.
- End by asking if they want to proceed with the chosen option to build an itinerary.
Don't:
- Create day-wise itineraries or booking steps.
`;

const ITINERARY_PLANNER_PROMPT = `
You are Itinerary Planner. Create concise, day-wise schedules once the destination and basic trip details are known.
Rules:
- If any critical info is missing (origin, destination, dates or nights, travelers), ask once to fill gaps, then confirm before planning.
- Output days with Morning / Afternoon / Evening, plus brief commute notes and a budget snapshot.
- End with next steps (e.g., check flights/hotels) and ask if the user wants booking support.
`;

const BOOKING_AGENT_PROMPT = `
You are Booking Agent. Help with flights/hotels after an itinerary or clear dates/destination exist.
Do:
- Confirm missing essentials (names optional), destination, dates, pax, budget band, preferences (hotel area/class; flight class/airlines).
- Provide a ready-to-book checklist and a clear summary of selections to proceed.
Don't:
- Invent live prices. Keep instructions and structured info ready for execution.
`;

// Shared local context for this manager scenario
export interface AppContext {
  userInfo?: { name?: string; uid?: number };
  trip: {
    originCity?: string;
    destinationCity?: string;
    startDate?: string; // YYYY-MM-DD
    endDate?: string;   // YYYY-MM-DD
    adults?: number;
    budgetAmount?: number;
    currency?: string;
    bookingConfirmed?: boolean;
  };
  logger: { log: (...args: any[]) => void };
}

function contextSnapshot(runContext?: RunContext<AppContext>): string {
  const ctx = runContext?.context;
  if (!ctx) return '';
  const snapshot = { user: ctx.userInfo, trip: ctx.trip };
  return `\n\n[Local Context Snapshot]\n${JSON.stringify(snapshot, null, 2)}\n`;
}

function captureTripParamsSchema() {
  return z.object({
    originCity: z.string().nullable().optional(),
    destinationCity: z.string().nullable().optional(),
    startDate: z.string().describe('YYYY-MM-DD').nullable().optional(),
    endDate: z.string().describe('YYYY-MM-DD').nullable().optional(),
    adults: z.number().int().positive().nullable().optional(),
    budgetAmount: z.number().positive().nullable().optional(),
    currency: z.string().nullable().optional(),
  });
}

const captureTripParams = tool<ReturnType<typeof captureTripParamsSchema>, AppContext>({
  name: 'capture_trip_params',
  description: 'Update local context with trip details (origin, destination, dates, pax, budget, currency).',
  parameters: captureTripParamsSchema(),
  execute: async (
    args: z.infer<ReturnType<typeof captureTripParamsSchema>>,
    runContext?: RunContext<AppContext>,
  ): Promise<string> => {
    const ctx = runContext?.context;
    if (!ctx) return 'No context';
    const updates: Partial<AppContext['trip']> = {};
    if (args.originCity ?? undefined) updates.originCity = args.originCity ?? undefined;
    if (args.destinationCity ?? undefined) updates.destinationCity = args.destinationCity ?? undefined;
    if (args.startDate ?? undefined) updates.startDate = args.startDate ?? undefined;
    if (args.endDate ?? undefined) updates.endDate = args.endDate ?? undefined;
    if (typeof args.adults === 'number') updates.adults = args.adults;
    if (typeof args.budgetAmount === 'number') updates.budgetAmount = args.budgetAmount;
    if (args.currency ?? undefined) updates.currency = args.currency ?? undefined;
    ctx.trip = { ...ctx.trip, ...updates };
    ctx.logger.log('[capture_trip_params] Trip context updated:', ctx.trip);
    return 'Trip parameters captured.';
  },
});

// Specialists
const destinationAgent = new Agent({
  name: 'Destination Decider Agent',
  instructions: (rc?: RunContext<AppContext>) => [
    DESTINATION_DECIDER_PROMPT,
    '',
    'Tool policy (required): On each user turn, extract any of originCity, destinationCity, startDate, endDate, adults, budgetAmount, currency,',
    'then call capture_trip_params to persist them to local context. Include only fields you can confidently extract; normalize ₹ → INR.',
    contextSnapshot(rc),
  ].join('\n'),
  tools: [captureTripParams],
  modelSettings:{toolChoice: 'required'}
});

const itineraryAgent = new Agent({
  name: 'Itinerary Planner Agent',
  instructions: (rc?: RunContext<AppContext>) => [
    ITINERARY_PLANNER_PROMPT,
    '',
    'Tool policy (required): Before planning/refining, extract any of originCity, destinationCity, startDate, endDate, adults, budgetAmount, currency,',
    'then call capture_trip_params to persist them. Include only known fields; normalize ₹ → INR.',
    contextSnapshot(rc),
  ].join('\n'),
  tools: [captureTripParams],
  modelSettings:{toolChoice: 'required'}
});

const bookingAgent = new Agent({
  name: 'Booking Agent',
  instructions: (rc?: RunContext<AppContext>) => [
    BOOKING_AGENT_PROMPT,
    '',
    'Tool policy (required): On each user turn, extract any of originCity, destinationCity, startDate, endDate, adults, budgetAmount, currency,',
    'then call capture_trip_params to persist them to local context.',
    contextSnapshot(rc),
  ].join('\n'),
  tools: [captureTripParams],
  modelSettings:{toolChoice: 'required'}
});

// Expose specialists as tools for the Manager (agents-as-tools pattern)
const destinationTool = destinationAgent.asTool({
  toolName: 'transfer_to_destination_decider',
  toolDescription: 'Help the user choose a destination based on interests, vibe, and constraints.',
});

const itineraryTool = itineraryAgent.asTool({
  toolName: 'transfer_to_itinerary_planner',
  toolDescription: 'Create a day-wise itinerary once destination and basics are available.',
});

const bookingTool = bookingAgent.asTool({
  toolName: 'transfer_to_booking_agent',
  toolDescription: 'Assist with booking flights/hotels after plan and dates are set.',
});

// Manager with agents-as-tools wired in
export const managerAgent = new Agent({
  name: 'Manager Agent',
  instructions: `${RECOMMENDED_PROMPT_PREFIX}\n\n${MANAGER_PROMPT}`,
  tools: [destinationTool, itineraryTool, bookingTool],
  modelSettings:{toolChoice: 'required'}
});

// Tiny demo showcasing routing
async function demo() {
  const cases = [
    'Where should I go in July with a mid budget and great food?',
    'Plan 5 days in Rome next month for two adults.',
    'Book me a 3-night hotel near Centro Storico, Rome, mid-range.',
  ];

  const appContext: AppContext = { userInfo: { name: 'Harsh', uid: 1 }, trip: {}, logger: console };

  for (const prompt of cases) {
    const res = await run(managerAgent, [user(prompt)], { context: appContext });
    console.log('\n=== User ===');
    console.log(prompt);
    console.log('\n=== Assistant ===');
    console.log(typeof res.finalOutput === 'string' ? res.finalOutput : String(res.finalOutput));
    console.log('\n=== ctx.trip ===');
    console.log(JSON.stringify(appContext.trip, null, 2));
  }
}

if (require.main === module) {
  demo().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

// Debug lifecycle hooks for specialists and manager
destinationAgent.on('agent_start', (ctx, agent) => {
  // eslint-disable-next-line no-console
  console.log(`[${agent.name}] started`);
  // eslint-disable-next-line no-console
  // @ts-ignore
  console.log(`[${agent.name}] ctx.trip:`, (ctx as any)?.context?.trip);
});
destinationAgent.on('agent_end', (ctx, output) => {
  // eslint-disable-next-line no-console
  console.log('[agent] produced:', output);
  // eslint-disable-next-line no-console
  // @ts-ignore
  console.log('[agent] ctx.trip at end:', (ctx as any)?.context?.trip);
});

itineraryAgent.on('agent_start', (ctx, agent) => {
  // eslint-disable-next-line no-console
  console.log(`[${agent.name}] started`);
  // eslint-disable-next-line no-console
  // @ts-ignore
  console.log(`[${agent.name}] ctx.trip:`, (ctx as any)?.context?.trip);
});
itineraryAgent.on('agent_end', (ctx, output) => {
  // eslint-disable-next-line no-console
  console.log('[agent] produced:', output);
  // eslint-disable-next-line no-console
  // @ts-ignore
  console.log('[agent] ctx.trip at end:', (ctx as any)?.context?.trip);
});

bookingAgent.on('agent_start', (ctx, agent) => {
  // eslint-disable-next-line no-console
  console.log(`[${agent.name}] started`);
  // eslint-disable-next-line no-console
  // @ts-ignore
  console.log(`[${agent.name}] ctx.trip:`, (ctx as any)?.context?.trip);
});
bookingAgent.on('agent_end', (ctx, output) => {
  // eslint-disable-next-line no-console
  console.log('[agent] produced:', output);
  // eslint-disable-next-line no-console
  // @ts-ignore
  console.log('[agent] ctx.trip at end:', (ctx as any)?.context?.trip);
});

managerAgent.on('agent_start', (ctx, agent) => {
  // eslint-disable-next-line no-console
  console.log(`[${agent.name}] started`);
  // eslint-disable-next-line no-console
  // @ts-ignore
  console.log(`[${agent.name}] ctx.trip:`, (ctx as any)?.context?.trip);
});
managerAgent.on('agent_end', (ctx, output) => {
  // eslint-disable-next-line no-console
  console.log('[agent] produced:', output);
  // eslint-disable-next-line no-console
  // @ts-ignore
  console.log('[agent] ctx.trip at end:', (ctx as any)?.context?.trip);
});


