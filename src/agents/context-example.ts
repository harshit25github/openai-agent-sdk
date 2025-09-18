/**
 * Context Management Example with three agents: Gateway → TripPlanner → Booking
 *
 * - Demonstrates Local Context (RunContext<T>) being shared across agents and tools
 * - The Gateway receives initial context and transfers it to TripPlanner/Booking as needed
 * - Tools update the local context; agents read from it to personalize instructions
 *
 * Reference: OpenAI Agents SDK — Context management
 * https://openai.github.io/openai-agents-js/guides/context/
 */

import { Agent, RunContext, run, tool, user } from '@openai/agents';
import { z } from 'zod';
import { AGENT_PROMPTS } from './prompts';
import 'dotenv/config';
import { RECOMMENDED_PROMPT_PREFIX } from '@openai/agents-core/extensions';

// Feature flag: keep helper available for experiments, but OFF by default
const USE_TEST_EXTRACTOR = false;

// Shared app-level local context used by ALL agents/tools in this run
export interface AppContext {
  userInfo: {
    name: string;
    uid: number;
  };
  trip: {
    originCity?: string;
    destinationCity?: string;
    startDate?: string; // YYYY-MM-DD
    endDate?: string;   // YYYY-MM-DD
    adults?: number;
    budgetAmount?: number; // numeric value only
    currency?: string;     // e.g., INR, USD
    bookingConfirmed?: boolean;
  };
  logger: {
    log: (...args: any[]) => void;
  };
}

// Utility to embed a compact snapshot of local context into agent instructions
function contextSnapshot(runContext?: RunContext<AppContext>): string {
  const ctx = runContext?.context;
  if (!ctx) return '';
  const snapshot = {
    user: ctx.userInfo,
    trip: ctx.trip,
  };
  return `\n\n[Local Context Snapshot]\n${JSON.stringify(snapshot, null, 2)}\n`;
}

// Tool to capture/update trip parameters in the shared local context
const captureTripParams = tool<ReturnType<typeof captureTripParamsSchema>, AppContext>({
  name: 'capture_trip_params',
  description: 'Update local context with any provided trip details (origin, destination, dates, pax, budget, currency).',
  parameters: captureTripParamsSchema(),
  execute: async (
    args: z.infer<ReturnType<typeof captureTripParamsSchema>>,
    runContext?: RunContext<AppContext>,
  ): Promise<string> => {
    const ctx = runContext?.context;
    if (!ctx) return 'No context available';

    const updates: Partial<AppContext['trip']> = {};
    if (args.originCity) updates.originCity = args.originCity;
    if (args.destinationCity) updates.destinationCity = args.destinationCity;
    if (args.startDate) updates.startDate = args.startDate;
    if (args.endDate) updates.endDate = args.endDate;
    if (typeof args.adults === 'number') updates.adults = args.adults;
    if (typeof args.budgetAmount === 'number') updates.budgetAmount = args.budgetAmount;
    if (args.currency) updates.currency = args.currency;

    ctx.trip = { ...ctx.trip, ...updates };
    ctx.logger.log('[capture_trip_params] Trip context updated:', ctx.trip);
    return 'Trip parameters captured in local context.';
  },
});

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

// Booking confirmation tool (writes a confirmation flag into context)
const confirmBooking = tool<ReturnType<typeof confirmBookingSchema>, AppContext>({
  name: 'confirm_booking',
  description: 'Mark the booking as confirmed in local context once user agrees.',
  parameters: confirmBookingSchema(),
  execute: async (
    args: z.infer<ReturnType<typeof confirmBookingSchema>>,
    runContext?: RunContext<AppContext>,
  ): Promise<string> => {
    const ctx = runContext?.context;
    if (!ctx) return 'No context available';
    if (!args.confirm) return 'Booking not confirmed by user.';
    ctx.trip.bookingConfirmed = true;
    ctx.logger.log('[confirm_booking] Booking confirmed with context:', ctx.trip);
    return 'Booking has been confirmed in local context.';
  },
});

function confirmBookingSchema() {
  return z.object({
    confirm: z.boolean().describe('Set true to confirm booking.'),
  });
}

// -----------------------------------------------------------------------------
// Test helper: naive extractor to ensure local context gets updated in demos
// -----------------------------------------------------------------------------
async function naiveExtractAndCapture(
  userText: string,
  appContext: AppContext,
): Promise<void> {
  const args: z.infer<ReturnType<typeof captureTripParamsSchema>> = {};

  // Origin city: "from Mumbai"
  const originMatch = userText.match(/\bfrom\s+([A-Z][a-zA-Z]+)\b/);
  if (originMatch) args.originCity = originMatch[1];

  // Destination city: variants like "to Rome", "in Rome", "of Rome"
  const destMatch = userText.match(/\b(?:to|in|of)\s+([A-Z][a-zA-Z]+)\b/);
  if (destMatch) args.destinationCity = destMatch[1];
  if (!args.destinationCity) {
    // Fallback: "thinking of Rome" or standalone capitalized token near travel words
    const thinking = userText.match(/thinking\s+(?:about|of)\s+([A-Z][a-zA-Z]+)\b/);
    if (thinking) args.destinationCity = thinking[1];
  }

  // Dates: YYYY-MM-DD to YYYY-MM-DD
  const range = userText.match(/(\d{4}-\d{2}-\d{2})\s*(?:to|–|-)\s*(\d{4}-\d{2}-\d{2})/);
  if (range) {
    args.startDate = range[1];
    args.endDate = range[2];
  } else {
    const startOnly = userText.match(/starting\s+(\d{4}-\d{2}-\d{2})/);
    if (startOnly) args.startDate = startOnly[1];
  }

  // Pax: e.g., "2 adults"
  const adults = userText.match(/(\d+)\s+adults?\b/);
  if (adults) args.adults = Number(adults[1]);

  // Budget + currency: ₹ or $
  const inr = userText.match(/₹\s?([\d,]+(?:\.\d+)?)/);
  const usd = userText.match(/\$\s?([\d,]+(?:\.\d+)?)/);
  if (inr) {
    args.currency = 'INR';
    args.budgetAmount = Number(inr[1].replace(/,/g, ''));
  } else if (usd) {
    args.currency = 'USD';
    args.budgetAmount = Number(usd[1].replace(/,/g, ''));
  }

  // If nothing detected, skip
  const hasAny = Object.keys(args).length > 0;
  if (!hasAny) return;

  // Directly update shared local context (test helper path)
  const updates: Partial<AppContext['trip']> = {};
  if (args.originCity ?? undefined) updates.originCity = args.originCity ?? undefined;
  if (args.destinationCity ?? undefined) updates.destinationCity = args.destinationCity ?? undefined;
  if (args.startDate ?? undefined) updates.startDate = args.startDate ?? undefined;
  if (args.endDate ?? undefined) updates.endDate = args.endDate ?? undefined;
  if (typeof args.adults === 'number') updates.adults = args.adults;
  if (typeof args.budgetAmount === 'number') updates.budgetAmount = args.budgetAmount;
  if (args.currency ?? undefined) updates.currency = args.currency ?? undefined;
  appContext.trip = { ...appContext.trip, ...updates };
  appContext.logger.log('[naiveExtractAndCapture] Trip context updated:', appContext.trip);
}

// 1) Booking Agent — finalizes bookings; reads trip details from local context
const bookingAgent = new Agent<AppContext>({
  name: 'Booking Agent',
  instructions: (rc?: RunContext<AppContext>) => {
    return [
      'You are the Booking Agent. You finalize reservations based on the current trip details in local context.',
      '- If trip details are incomplete, ask minimal clarifying questions.',
      '- Never generate trip planning content; focus on booking confirmation and next steps.',
      '',
      'Tool policy (required): On each user message, first extract any of the following fields and then call capture_trip_params before responding:',
      'originCity, destinationCity, startDate (YYYY-MM-DD), endDate (YYYY-MM-DD), adults, budgetAmount, currency.',
      'Normalize inputs: If the user writes ₹120000, set currency="INR" and budgetAmount=120000.',
      'Example args: { "originCity": "Mumbai", "destinationCity": "Rome", "adults": 2, "budgetAmount": 120000, "currency": "INR" }',
      contextSnapshot(rc),
    ].join('\n');
  },
  tools: [confirmBooking, captureTripParams],
});

// Debug lifecycle hooks for Booking Agent
bookingAgent.on('agent_start', (ctx, agent) => {
  // eslint-disable-next-line no-console
  console.log(`[${agent.name}] started`);
  // eslint-disable-next-line no-console
  // @ts-ignore best-effort peek at local context.trip if present
  console.log(`[${agent.name}] ctx.trip:`, (ctx as any)?.context?.trip);
});
bookingAgent.on('agent_end', (ctx, output) => {
  // eslint-disable-next-line no-console
  console.log('[agent] produced:', output);
  // eslint-disable-next-line no-console
  // @ts-ignore best-effort peek at local context.trip if present
  console.log('[agent] ctx.trip at end:', (ctx as any)?.context?.trip);
});

// 2) Trip Planner Agent — plans itineraries; updates local context via tools
const tripPlannerAgent = new Agent<AppContext>({
  name: 'Trip Planner Agent',
  instructions: (rc?: RunContext<AppContext>) => {
    // Reuse the detailed Trip Planner system prompt from prompts.ts, and append a local context snapshot
    return [
      AGENT_PROMPTS.TRIP_PLANNER,
      '',
      'Tool policy (required): Before providing or refining any plan, extract any of',
      'originCity, destinationCity, startDate (YYYY-MM-DD), endDate (YYYY-MM-DD), adults, budgetAmount, currency,',
      'then call capture_trip_params to persist these into the shared local context. Normalize currencies (₹ → INR).',
      'Include only fields you can confidently extract; omit unknowns.',
      contextSnapshot(rc),
    ].join('\n');
  },
  tools: [captureTripParams],
  modelSettings:{toolChoice: 'required'}
});

// Debug lifecycle hooks for Trip Planner Agent
tripPlannerAgent.on('agent_start', (ctx, agent) => {
  // eslint-disable-next-line no-console
  console.log(`[${agent.name}] started`);
  // eslint-disable-next-line no-console
  // @ts-ignore best-effort peek at local context.trip if present
  console.log(`[${agent.name}] ctx.trip:`, (ctx as any)?.context?.trip);
});
tripPlannerAgent.on('agent_end', (ctx, output) => {
  // eslint-disable-next-line no-console
  console.log('[agent] produced:', output);
  // eslint-disable-next-line no-console
  // @ts-ignore best-effort peek at local context.trip if present
  console.log('[agent] ctx.trip at end:', (ctx as any)?.context?.trip);
});

// 3) Gateway Agent — routes requests; NEVER produces domain content
const gatewayAgent = new Agent<AppContext>({
  name: 'Gateway Agent',
  instructions: (rc?: RunContext<AppContext>) => {
    // Base it on the orchestrator prompt style from prompts.ts and tailor to the two downstream agents in this example
    const base = [
      'You are the Travel Gateway Agent (orchestrator).',
      'Route immediately and only to the correct specialist:',
      '- Trip Planner Agent → for creating/optimizing itineraries',
      '- Booking Agent → for reservations/confirmations',
      'You NEVER create travel content yourself; keep responses short and warm (e.g., “Sure—connecting you now.”).',
  
    ].join('\n');
    return `${RECOMMENDED_PROMPT_PREFIX}${base}\n${contextSnapshot(rc)}`;
  },
  tools: [],
  handoffs: [tripPlannerAgent, bookingAgent],
  modelSettings:{toolChoice: 'required'}
});

// Debug lifecycle hooks for Gateway Agent
gatewayAgent.on('agent_start', (ctx, agent) => {
  // eslint-disable-next-line no-console
  console.log(`[${agent.name}] started`);
  // eslint-disable-next-line no-console
  // @ts-ignore best-effort peek at local context.trip if present
  console.log(`[${agent.name}] ctx.trip:`, (ctx as any)?.context?.trip);
});
gatewayAgent.on('agent_end', (ctx, output) => {
  // eslint-disable-next-line no-console
  console.log('[agent] produced:', output);
  // eslint-disable-next-line no-console
  // @ts-ignore best-effort peek at local context.trip if present
  console.log('[agent] ctx.trip at end:', (ctx as any)?.context?.trip);
});

// Example runner to demonstrate context flowing across agents
export async function demoContextManagement() {
  const appContext: AppContext = {
    userInfo: { name: 'Harsh', uid: 1 },
    trip: {},
    logger: console,
  };

  // 1) User provides initial info to the Gateway; Gateway updates local context and routes
  const turn1UserMsg = 'Hi! We are 2 adults from Mumbai thinking of Rome next month. Budget is ₹120000 per person.';
  if (USE_TEST_EXTRACTOR) {
    await naiveExtractAndCapture(turn1UserMsg, appContext);
  }
  // eslint-disable-next-line no-console
  console.log('\n[TURN 1 USER]\n', turn1UserMsg);
  const turn1 = await run(gatewayAgent, [user(turn1UserMsg)], { context: appContext });
  appContext.logger.log('\n[TURN 1 OUTPUT]\n', turn1.finalOutput);
  appContext.logger.log('\n[CONTEXT AFTER TURN 1]\n', JSON.stringify(appContext.trip, null, 2));

  // 2) User asks to proceed with booking; we run the Booking Agent with the SAME local context
  const turn2UserMsg = 'Please book hotels and flights for 5 nights starting 2026-05-03.';
  if (USE_TEST_EXTRACTOR) {
    await naiveExtractAndCapture(turn2UserMsg, appContext);
  }
  // eslint-disable-next-line no-console
  console.log('\n[TURN 2 USER]\n', turn2UserMsg);
  const turn2 = await run(bookingAgent, [user(turn2UserMsg)], { context: appContext });
  appContext.logger.log('\n[TURN 2 OUTPUT]\n', turn2.finalOutput);
  appContext.logger.log('\n[CONTEXT AFTER TURN 2]\n', JSON.stringify(appContext.trip, null, 2));
}

// Additional demos: multi-turn incremental context sharing
export async function demoMultiTurnGradualContext() {
  const appContext: AppContext = {
    userInfo: { name: 'Harsh', uid: 1 },
    trip: {},
    logger: console,
  };

  // Turn A: user only shares pax
  const a = 'We are 2 adults planning a trip.';
  if (USE_TEST_EXTRACTOR) {
    await naiveExtractAndCapture(a, appContext);
  }
  // eslint-disable-next-line no-console
  console.log('\n[TURN A USER]\n', a);
  const outA = await run(gatewayAgent, [user(a)], { context: appContext });
  appContext.logger.log('\n[TURN A OUTPUT]\n', outA.finalOutput);
  appContext.logger.log('\n[CONTEXT AFTER A]\n', JSON.stringify(appContext.trip, null, 2));

  // Turn B: user shares origin later
  const b = 'We will be flying from Mumbai.';
  if (USE_TEST_EXTRACTOR) {
    await naiveExtractAndCapture(b, appContext);
  }
  // eslint-disable-next-line no-console
  console.log('\n[TURN B USER]\n', b);
  const outB = await run(gatewayAgent, [user(b)], { context: appContext });
  appContext.logger.log('\n[TURN B OUTPUT]\n', outB.finalOutput);
  appContext.logger.log('\n[CONTEXT AFTER B]\n', JSON.stringify(appContext.trip, null, 2));

  // Turn C: user decides destination
  const c = 'Destination is Rome.';
  if (USE_TEST_EXTRACTOR) {
    await naiveExtractAndCapture(c, appContext);
  }
  // eslint-disable-next-line no-console
  console.log('\n[TURN C USER]\n', c);
  const outC = await run(gatewayAgent, [user(c)], { context: appContext });
  appContext.logger.log('\n[TURN C OUTPUT]\n', outC.finalOutput);
  appContext.logger.log('\n[CONTEXT AFTER C]\n', JSON.stringify(appContext.trip, null, 2));

  // Turn D: user provides budget with currency symbol
  const d = 'Budget is ₹150000 per person.';
  if (USE_TEST_EXTRACTOR) {
    await naiveExtractAndCapture(d, appContext);
  }
  // eslint-disable-next-line no-console
  console.log('\n[TURN D USER]\n', d);
  const outD = await run(gatewayAgent, [user(d)], { context: appContext });
  appContext.logger.log('\n[TURN D OUTPUT]\n', outD.finalOutput);
  appContext.logger.log('\n[CONTEXT AFTER D]\n', JSON.stringify(appContext.trip, null, 2));

  // Turn E: user provides exact start date
  const e = 'We can start on 2026-05-03 for 5 nights.';
  if (USE_TEST_EXTRACTOR) {
    await naiveExtractAndCapture(e, appContext);
  }
  // eslint-disable-next-line no-console
  console.log('\n[TURN E USER]\n', e);
  const outE = await run(gatewayAgent, [user(e)], { context: appContext });
  appContext.logger.log('\n[TURN E OUTPUT]\n', outE.finalOutput);
  appContext.logger.log('\n[CONTEXT AFTER E]\n', JSON.stringify(appContext.trip, null, 2));
}

export async function demoLateCurrencyAndDates() {
  const appContext: AppContext = {
    userInfo: { name: 'Harsh', uid: 2 },
    trip: {},
    logger: console,
  };

  const t1 = 'Two adults to Paris from Delhi.';
  if (USE_TEST_EXTRACTOR) {
    await naiveExtractAndCapture(t1, appContext);
  }
  // eslint-disable-next-line no-console
  console.log('\n[LATE-1 USER]\n', t1);
  await run(gatewayAgent, [user(t1)], { context: appContext });
  appContext.logger.log('\n[LATE-1]\n', JSON.stringify(appContext.trip, null, 2));

  const t2 = 'Dates 2026-07-10 to 2026-07-16.';
  if (USE_TEST_EXTRACTOR) {
    await naiveExtractAndCapture(t2, appContext);
  }
  // eslint-disable-next-line no-console
  console.log('\n[LATE-2 USER]\n', t2);
  await run(gatewayAgent, [user(t2)], { context: appContext });
  appContext.logger.log('\n[LATE-2]\n', JSON.stringify(appContext.trip, null, 2));

  const t3 = 'Budget around $2500 per person.';
  if (USE_TEST_EXTRACTOR) {
    await naiveExtractAndCapture(t3, appContext);
  }
  // eslint-disable-next-line no-console
  console.log('\n[LATE-3 USER]\n', t3);
  await run(gatewayAgent, [user(t3)], { context: appContext });
  appContext.logger.log('\n[LATE-3]\n', JSON.stringify(appContext.trip, null, 2));
}

// Allow running this file directly: ts-node src/agents/context-example.ts
if (require.main === module) {
    demoMultiTurnGradualContext().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}


