// structured-travel-flow.ts
import "dotenv/config";
import { Agent, handoff, run, webSearchTool } from "@openai/agents";
import { RECOMMENDED_PROMPT_PREFIX } from "@openai/agents-core/extensions";
import { z } from "zod";
import fs from "node:fs";

import { FLOW_PROMPTS } from "./prompts";

/** Shared slot state that tools and agents can mutate via context. */
type Slots = {
  origin?: string;
  destination?: string;
  startDate?: string; // ISO (YYYY-MM-DD)
  endDate?: string;   // ISO (YYYY-MM-DD)
  pax?: number;
  currency?: string;
  budgetType?: "fixed" | "flexible" | "range";
  budgetAmount?: number;
  hotelArea?: string;
  destinationVerified?: boolean;
  itineraryFinalized?: boolean;
};

const DestinationIntelSchema = z.object({
  destination: z.string(),
  visa: z.string(),
  safety: z.string(),
  entry_steps: z.array(z.string()).min(1),
  best_time: z.string(),
  health_practical: z.array(z.string()).min(1),
  sources: z.array(z.string()).min(1),
});

/** Destination Agent returns structured JSON briefing. */
const destinationAgent = new Agent({
  name: "Destination Intelligence Agent",
  model: "gpt-4.1-mini",
  instructions: FLOW_PROMPTS.DESTINATION,
  outputType: DestinationIntelSchema,
  tools: [webSearchTool()],
});

const checkDestinationTool = destinationAgent.asTool({
  toolName: "check_destination",
  toolDescription: "Validate a destination and retrieve visa, safety, entry, timing, and practical guidance as JSON.",
  parameters: z.object({
    destination: z.string().min(2).describe("City or region to validate."),
    countryHint: z.string().optional().describe("Country or region hint when available."),
    travelDates: z
      .object({
        start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Trip start date (ISO).").optional(),
        end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Trip end date (ISO).").optional(),
      })
      .optional(),
    pax: z.number().int().positive().optional().describe("Number of travellers."),
    notes: z.string().optional().describe("Any additional instructions or traveller context."),
  }),
});

/** Itinerary Agent consumes destination intel and renders briefs + plans. */
const itineraryAgent = new Agent({
  name: "Itinerary Planner Agent",
  model: "gpt-4o-mini",
  instructions: FLOW_PROMPTS.ITINERARY,
  tools: [checkDestinationTool],
});

/** Booking Agent finalises logistics after itinerary approval. */
const bookingAgent = new Agent({
  name: "Booking Specialist Agent",
  model: "gpt-4.1-mini",
  instructions: FLOW_PROMPTS.BOOKING,
});

/** Gateway orchestrator delegates via handoffs. */
const gatewayAgent = Agent.create({
  name: "Gateway Orchestrator",
  model: "gpt-4.1-mini",
  instructions: `${RECOMMENDED_PROMPT_PREFIX}\n${FLOW_PROMPTS.GATEWAY}`,
  handoffs: [
    handoff(destinationAgent),
    handoff(itineraryAgent),
    handoff(bookingAgent),
  ],
});

function persistResult(filename: string, payload: unknown) {
  fs.writeFileSync(filename, JSON.stringify(payload, null, 2));
}

/** Demo runner showcasing scenario coverage and tool traces. */
async function demo() {
  const slots: Slots = {
    pax: 2,
    currency: "INR",
  };

  // Scenario A: user jumps straight to planning.
  const jumpToPlan = await run(
    gatewayAgent,
    "Plan a five-day relaxed honeymoon in Bali this November with beach time and culture.",
    { context: { slots } }
  );

  persistResult("structured-result-plan.json", jumpToPlan);
  console.log("--- Scenario: Direct itinerary request ---");
  console.log(jumpToPlan.finalOutput);

  // Scenario B: staged flow destination -> itinerary -> booking.
  const stagedSlots: Slots = { ...slots };

  const destinationStep = await run(
    gatewayAgent,
    "I'm debating between Kyoto or Osaka for spring cherry blossoms. Which is safer and better for first timers?",
    { context: { slots: stagedSlots } }
  );
  persistResult("structured-result-destination.json", destinationStep);
  console.log("--- Scenario: Destination triage ---");
  console.log(destinationStep.finalOutput);

  try {
    const destinationIntel = JSON.parse(String(destinationStep.finalOutput ?? ""));
    if (destinationIntel?.destination) {
      stagedSlots.destination = destinationIntel.destination;
      stagedSlots.destinationVerified = true;
    }
  } catch (error) {
    console.warn("Could not parse destination output for slots update", error);
  }

  const itineraryStep = await run(
    gatewayAgent,
    "Thanks! Build a 4-day food-forward itinerary for the recommended city.",
    { context: { slots: stagedSlots } }
  );
  persistResult("structured-result-itinerary.json", itineraryStep);
  console.log("--- Scenario: Itinerary build ---");
  console.log(itineraryStep.finalOutput);
  stagedSlots.itineraryFinalized = true;

  const bookingStep = await run(
    gatewayAgent,
    "Perfect. Help me book flights and a boutique hotel now.",
    { context: { slots: stagedSlots } }
  );
  persistResult("structured-result-booking.json", bookingStep);
  console.log("--- Scenario: Booking support ---");
  console.log(bookingStep.finalOutput);
}

demo().catch((error) => {
  console.error(error);
});
