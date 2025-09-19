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
    itinerary?: Array<{
      day?: number;
      date?: string;
      morning?: string[];
      afternoon?: string[];
      evening?: string[];
    }>;
    itineraryStatus?: 'fresh' | 'stale' | null;
    lastItinerarySignature?: string | null;
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

    // Detect date change to clear any stale itinerary
    const prevStart = ctx.trip.startDate;
    const prevEnd = ctx.trip.endDate;
    const prevSig = ctx.trip.lastItinerarySignature ?? null;
    const nextStart = args.startDate ?? prevStart;
    const nextEnd = args.endDate ?? prevEnd;
    const datesChanged = (args.startDate && args.startDate !== prevStart) || (args.endDate && args.endDate !== prevEnd);

    const updates: Partial<AppContext['trip']> = {};
    if (args.originCity) updates.originCity = args.originCity;
    if (args.destinationCity) updates.destinationCity = args.destinationCity;
    if (args.startDate) updates.startDate = args.startDate;
    if (args.endDate) updates.endDate = args.endDate;
    if (typeof args.adults === 'number') updates.adults = args.adults;
    if (typeof args.budgetAmount === 'number') updates.budgetAmount = args.budgetAmount;
    if (args.currency) updates.currency = args.currency;

    // Apply updates
    ctx.trip = { ...ctx.trip, ...updates };

    // Compute signature of critical fields to decide itinerary staleness
    const critical = {
      destinationCity: ctx.trip.destinationCity ?? null,
      startDate: ctx.trip.startDate ?? null,
      endDate: ctx.trip.endDate ?? null,
      adults: ctx.trip.adults ?? null,
      budgetAmount: ctx.trip.budgetAmount ?? null,
    };
    const newSig = JSON.stringify(critical);
    ctx.trip.lastItinerarySignature = newSig;

    if (newSig !== prevSig) {
      ctx.trip.itineraryStatus = 'stale';
    }

    // If dates changed, clear existing itinerary to avoid stale plans
    if (datesChanged && Array.isArray(ctx.trip.itinerary) && ctx.trip.itinerary.length > 0) {
      ctx.logger.log('[capture_trip_params] Dates changed from', prevStart, prevEnd, 'to', nextStart, nextEnd, '— marking existing itinerary stale');
      // Keep old itinerary but mark it stale; safety net or next plan will overwrite
      ctx.trip.itineraryStatus = 'stale';
    }
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

// Tool to capture itinerary day segments into local context
const captureItineraryDays = tool<ReturnType<typeof captureItineraryDaysSchema>, AppContext>({
  name: 'capture_itinerary_days',
  description: 'Persist a day-wise itinerary into local context with morning/afternoon/evening segments.',
  parameters: captureItineraryDaysSchema(),
  execute: async (
    args: z.infer<ReturnType<typeof captureItineraryDaysSchema>>,
    runContext?: RunContext<AppContext>,
  ): Promise<string> => {
    const ctx = runContext?.context;
    if (!ctx) return 'No context available';
    const days = Array.isArray(args.days) ? args.days : [];
    const normalized = days.map((d) => ({
      day: d.day ?? undefined,
      date: d.date ?? undefined,
      morning: d.morning ?? [],
      afternoon: d.afternoon ?? [],
      evening: d.evening ?? [],
    }));
    ctx.trip.itinerary = normalized;
    ctx.logger.log('[capture_itinerary_days] Itinerary saved with', normalized.length, 'days');
    return `Saved ${normalized.length} itinerary day(s).`;
  },
});

function captureItineraryDaysSchema() {
  return z.object({
    days: z.array(z.object({
      day: z.number().int().positive().nullable().optional(),
      date: z.string().describe('YYYY-MM-DD').nullable().optional(),
      morning: z.array(z.string()).nullable().optional(),
      afternoon: z.array(z.string()).nullable().optional(),
      evening: z.array(z.string()).nullable().optional(),
    })).describe('A list of itinerary days with time-of-day segments.'),
  });
}

// -----------------------------------------------------------------------------
// Post-run safety net: parse itinerary text and persist if model forgot
// -----------------------------------------------------------------------------
function parseItineraryFromText(text: string): Array<{
  day?: number;
  date?: string;
  morning?: string[];
  afternoon?: string[];
  evening?: string[];
}> {
  const lines = text.split(/\r?\n/);
  const days: Array<{
    day?: number;
    date?: string;
    morning: string[];
    afternoon: string[];
    evening: string[];
  }> = [];

  let current: { day?: number; date?: string; morning: string[]; afternoon: string[]; evening: string[] } | null = null;
  let currentSegment: 'morning' | 'afternoon' | 'evening' | null = null;

  const dayHeader = /^\s*Day\s*(\d+)?(?:\s*\(([^)]+)\))?\s*[:\-]?/i;
  const segHeader = /^\s*(?:[-•]\s*)?(Morning|Afternoon|Evening)\s*:\s*(.*)$/i;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const mDay = line.match(dayHeader);
    if (mDay) {
      if (current) days.push(current);
      const dayNum = mDay[1] ? Number(mDay[1]) : undefined;
      // Attempt to normalize to YYYY-MM-DD within parentheses if present; otherwise keep as-is
      const dateText = mDay[2];
      const dateIso = dateText && /\d{4}-\d{2}-\d{2}/.test(dateText) ? (dateText.match(/\d{4}-\d{2}-\d{2}/)![0]) : undefined;
      current = { day: dayNum, date: dateIso, morning: [], afternoon: [], evening: [] };
      currentSegment = null;
      continue;
    }

    const mSeg = line.match(segHeader);
    if (mSeg) {
      if (!current) {
        current = { morning: [], afternoon: [], evening: [] };
      }
      const seg = mSeg[1].toLowerCase() as 'morning' | 'afternoon' | 'evening';
      currentSegment = seg;
      const rest = mSeg[2]?.trim();
      if (rest) current[seg].push(rest);
      continue;
    }

    // If continuing bullet under current segment
    if (current && currentSegment && /^[-•]/.test(line)) {
      const content = line.replace(/^[-•]\s*/, '').trim();
      if (content) current[currentSegment].push(content);
      continue;
    }
  }

  if (current) days.push(current);
  return days.filter(d => (d.morning.length + d.afternoon.length + d.evening.length) > 0);
}

async function ensureItinerarySavedIfMissing(outputText: string, appContext: AppContext): Promise<void> {
  const hasPlanText = /\bDay\b/i.test(outputText) && /(Morning|Afternoon|Evening)\s*:/i.test(outputText);
  const hasItin = Array.isArray(appContext.trip.itinerary) && appContext.trip.itinerary.length > 0;
  if (!hasPlanText || hasItin) return;

  const parsed = parseItineraryFromText(outputText);
  if (parsed.length === 0) return;
  // Directly persist into local context (safety net path)
  appContext.trip.itinerary = parsed;
  appContext.logger.log('[safety_net] Parsed and saved itinerary days:', parsed.length);
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
      AGENT_PROMPTS.trpPromt,
      '',
      'Tool policy (required): Before providing or refining any plan, extract any of',
      'originCity, destinationCity, startDate (YYYY-MM-DD), endDate (YYYY-MM-DD), adults, budgetAmount, currency,',
      'then call capture_trip_params to persist these into the shared local context. Normalize currencies (₹ → INR).',
      'Include only fields you can confidently extract; omit unknowns.',
      '',
      'Itinerary persistence (required when you produce a day-wise plan):',
      '- After you present the itinerary, immediately call capture_itinerary_days with a days array.',
      '- Each day item should include day number and/or date if known, and arrays for morning, afternoon, evening with short activity strings.',
      '- Ensure the tool payload matches what you just presented to the user.',
      '- If dates have changed since the previous plan, recreate the itinerary and re-save using capture_itinerary_days (overwrite any prior itinerary).',
      contextSnapshot(rc),
    ].join('\n');
  },
  tools: [captureTripParams, captureItineraryDays],
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
tripPlannerAgent.on('agent_end', async (ctx, output) => {
  // eslint-disable-next-line no-console
  console.log('[agent] produced:', output);
  // eslint-disable-next-line no-console
  // @ts-ignore best-effort peek at local context.trip if present
  console.log('[agent] ctx.trip at end:', (ctx as any)?.context?.trip);
  try {
    // @ts-ignore
    const appCtx = (ctx as any)?.context as AppContext | undefined;
    if (!appCtx) return;
    const isStale = appCtx.trip.itineraryStatus === 'stale' || !Array.isArray(appCtx.trip.itinerary) || appCtx.trip.itinerary.length === 0;
    const finalText = typeof output === 'string' ? output : String(output ?? '');
    if (isStale && finalText) {
      await ensureItinerarySavedIfMissing(String(finalText), appCtx);
      if (Array.isArray(appCtx.trip.itinerary) && appCtx.trip.itinerary.length > 0) {
        appCtx.trip.itineraryStatus = 'fresh';
      }
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[agent_end safety_net] failed', e);
  }
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
  // Also inspect internal state context (SDK internal, best-effort)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const turn1StateCtx: any = (turn1 as any)?.state?._context;
  // eslint-disable-next-line no-console
  console.log('\n[TURN 1 STATE CONTEXT]\n', turn1StateCtx);
  // eslint-disable-next-line no-console
  console.log('[TURN 1 STATE CONTEXT trip]\n', turn1StateCtx?.trip);

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const turn2StateCtx: any = (turn2 as any)?.state?._context;
  // eslint-disable-next-line no-console
  console.log('\n[TURN 2 STATE CONTEXT]\n', turn2StateCtx);
  // eslint-disable-next-line no-console
  console.log('[TURN 2 STATE CONTEXT trip]\n', turn2StateCtx?.trip);
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const outAState: any = (outA as any)?.state?._context;
  // eslint-disable-next-line no-console
  console.log('\n[TURN A STATE CONTEXT]\n', outAState);
  // eslint-disable-next-line no-console
  console.log('[TURN A STATE CONTEXT trip]\n', outAState?.trip);

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const outBState: any = (outB as any)?.state?._context;
  // eslint-disable-next-line no-console
  console.log('\n[TURN B STATE CONTEXT]\n', outBState);
  // eslint-disable-next-line no-console
  console.log('[TURN B STATE CONTEXT trip]\n', outBState?.trip);

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const outCState: any = (outC as any)?.state?._context;
  // eslint-disable-next-line no-console
  console.log('\n[TURN C STATE CONTEXT]\n', outCState);
  // eslint-disable-next-line no-console
  console.log('[TURN C STATE CONTEXT trip]\n', outCState?.trip);

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const outDState: any = (outD as any)?.state?._context;
  // eslint-disable-next-line no-console
  console.log('\n[TURN D STATE CONTEXT]\n', outDState);
  // eslint-disable-next-line no-console
  console.log('[TURN D STATE CONTEXT trip]\n', outDState?.trip);

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const outEState: any = (outE as any)?.state?._context;
  // eslint-disable-next-line no-console
  console.log('\n[TURN E STATE CONTEXT]\n', outEState);
  // eslint-disable-next-line no-console
  console.log('[TURN E STATE CONTEXT trip]\n', outEState?.trip);
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
  // Not capturing run result for state here; keep appContext as source of truth

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

// Single-turn: user provides all details → gateway → trip planner → full itinerary
export async function demoAllDetailsSingleTurn() {
  const appContext: AppContext = {
    userInfo: { name: 'Harsh', uid: 3 },
    trip: {},
    logger: console,
  };

  const msg = 'From Mumbai to Rome, 2026-05-03 to 2026-05-08, 2 adults, total budget ₹300000, interests: history and food. Please create a day-wise itinerary.';
  // eslint-disable-next-line no-console
  console.log('\n[ALL-DETAILS USER]\n', msg);
  const res = await run(gatewayAgent, [user(msg)], { context: appContext });
  // eslint-disable-next-line no-console
  console.log('\n[ALL-DETAILS OUTPUT]\n', res.finalOutput);
  // eslint-disable-next-line no-console
  console.log('\n[ALL-DETAILS ctx.trip]\n', JSON.stringify(appContext.trip, null, 2));
}

// Change duration after initial itinerary, and verify itinerary is recreated
export async function demoChangeDurationRecreateItinerary() {
  const appContext: AppContext = {
    userInfo: { name: 'Harsh', uid: 4 },
    trip: {},
    logger: console,
  };

  const first = 'From Mumbai to Rome, 2026-05-03 to 2026-05-08, 2 adults, total budget ₹300000, interests: history and food. Please create a day-wise itinerary.';
  console.log('\n[RECREATE-1 USER]\n', first);
  const res1 = await run(gatewayAgent, [user(first)], { context: appContext });
  console.log('\n[RECREATE-1 OUTPUT]\n', res1.finalOutput);
  await ensureItinerarySavedIfMissing(String(res1.finalOutput ?? ''), appContext);
  console.log('\n[RECREATE-1 ctx.trip]\n', JSON.stringify(appContext.trip, null, 2));
  const beforeDays = appContext.trip.itinerary?.length || 0;
  console.log('[RECREATE-1 itinerary days]', beforeDays);

  const second = 'Change dates to 2026-05-04 to 2026-05-10 (6 nights) and recreate the day-wise itinerary, please.';
  console.log('\n[RECREATE-2 USER]\n', second);
  const res2 = await run(gatewayAgent, [user(second)], { context: appContext });
  console.log('\n[RECREATE-2 OUTPUT]\n', res2.finalOutput);
  await ensureItinerarySavedIfMissing(String(res2.finalOutput ?? ''), appContext);
  console.log('\n[RECREATE-2 ctx.trip]\n', JSON.stringify(appContext.trip, null, 2));
  const afterDays = appContext.trip.itinerary?.length || 0;
  console.log('[RECREATE-2 itinerary days]', afterDays);
}

// Allow running this file directly: ts-node src/agents/context-example.ts
if (require.main === module) {
    demoChangeDurationRecreateItinerary().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}


