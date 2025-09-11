# OpenAI Agent SDK Travel Examples: Complete TypeScript Guide

## Overview

The OpenAI Agent SDK is a lightweight framework for building AI agents that can use tools, work together, and maintain context across conversations. Think of it as a way to create specialized AI assistants that can perform specific tasks and coordinate with each other.

## 1. Agent Creation

**What it is:** Creating an AI agent is like hiring a specialized travel assistant. You give them a name, instructions, and tools to help travelers.

**File: `01-agent-creation.ts`**
```typescript
import { Agent, run } from '@openai/agents';

// Create a simple travel planning agent
const travelAgent = new Agent({
  name: 'Travel Planner',
  instructions: 'Help users plan their trips with destination recommendations.',
  model: 'gpt-4o-mini', // Optional - uses default if not specified
});

// Use the agent
async function planTrip() {
  const result = await run(
    travelAgent, 
    'I want to plan a 5-day trip to Japan in spring. What should I know?'
  );
  
  console.log(result.finalOutput);
}

// What happens: The agent receives your travel question and responds 
// using its instructions as guidance for helpful trip planning advice
planTrip();
```

## 2. Tools Implementation

**What it is:** Tools are like giving your travel agent special abilities - they can check flight prices, look up weather, or search for hotels instead of just talking.

**File: `02-tools-implementation.ts`**
```typescript
import { Agent, tool, run } from '@openai/agents';
import { z } from 'zod';

// Create a custom tool to check flight prices
const checkFlightPrices = tool({
  name: 'check_flight_prices',
  description: 'Get current flight prices between two cities',
  parameters: z.object({
    from: z.string(),
    to: z.string(),
    date: z.string(),
  }),
  async execute({ from, to, date }) {
    // In real app, this would call a flight API
    return `Flight from ${from} to ${date} on ${date}: $450 - $680`;
  },
});

// Create agent with the tool
const flightAgent = new Agent({
  name: 'Flight Assistant',
  instructions: 'Help find and compare flight prices.',
  tools: [checkFlightPrices], // Give the agent access to this tool
});

async function findFlights() {
  const result = await run(
    flightAgent,
    'What are flight prices from New York to London on March 15th?'
  );
  
  console.log(result.finalOutput);
}

// What happens: The agent can now automatically use the flight tool
// when users ask about prices, making it much more useful
findFlights();
```

## 3. Multi-Agent Systems

**What it is:** Instead of one agent doing everything, you can have specialists that hand off to each other - like a travel agency with different departments.

**File: `03-multi-agent-systems.ts`**
```typescript
import { Agent, run } from '@openai/agents';

// Create specialized agents
const bookingAgent = new Agent({
  name: 'Booking Specialist',
  instructions: 'Handle flight and hotel bookings with payment processing.',
});

const itineraryAgent = new Agent({
  name: 'Itinerary Planner',
  instructions: 'Create detailed day-by-day travel itineraries.',
});

const cancelAgent = new Agent({
  name: 'Cancellation Agent',
  instructions: 'Handle booking cancellations and refunds professionally.',
});

// Create main agent that can hand off to specialists
const travelDesk = new Agent({
  name: 'Travel Desk',
  instructions: 'Help with travel needs. Hand off to booking agent for bookings, itinerary agent for planning, cancellation agent for cancellations.',
  handoffs: [bookingAgent, itineraryAgent, cancelAgent], // Can transfer to these agents
});

async function handleTravelRequest() {
  const result = await run(
    travelDesk,
    'I need to book a flight to Paris and plan what to do there'
  );
  
  console.log(result.finalOutput);
}

// What happens: The main agent decides which specialist can best help
// and automatically transfers the conversation to them
handleTravelRequest();
```

## 4. Context Management

**What it is:** Context is like giving your agents access to user information and preferences that they can remember and use, but keeping sensitive data private.

**File: `04-context-management.ts`**
```typescript
import { Agent, tool, run, RunContextWrapper } from '@openai/agents';
import { z } from 'zod';

// Define what user information we want to track
interface TravelContext {
  userId: string;
  preferredAirline: string;
  budgetRange: string;
  loyaltyNumber?: string;
}

// Tool that uses context to personalize recommendations
const getPersonalizedDeals = tool({
  name: 'get_deals',
  description: 'Find deals based on user preferences',
  parameters: z.object({
    destination: z.string(),
  }),
  async execute({ destination }, context: RunContextWrapper<TravelContext>) {
    // Access user preferences from context
    const userPrefs = context.context;
    return `Found ${destination} deals for ${userPrefs.preferredAirline} in your ${userPrefs.budgetRange} budget range. Using loyalty #${userPrefs.loyaltyNumber || 'none'}.`;
  },
});

const personalizedAgent = new Agent<TravelContext>({
  name: 'Personal Travel Assistant',
  instructions: 'Provide personalized travel recommendations.',
  tools: [getPersonalizedDeals],
});

async function getPersonalizedHelp() {
  // User context - this data is available to tools but NOT sent to the AI model
  const userContext: TravelContext = {
    userId: 'user123',
    preferredAirline: 'Delta',
    budgetRange: 'mid-tier ($300-800)',
    loyaltyNumber: 'DL1234567',
  };

  const result = await run(
    personalizedAgent,
    'Show me deals to Rome',
    { context: userContext } // Pass private user data
  );
  
  console.log(result.finalOutput);
}

// What happens: Tools can access user preferences to provide personalized
// service while keeping sensitive data away from the AI model
getPersonalizedHelp();
```

## 5. Guardrails Implementation

**What it is:** Guardrails are like safety checks that prevent your travel agent from doing things it shouldn't - like booking fake trips or sharing private information.

**File: `05-guardrails-implementation.ts`**
```typescript
import { 
  Agent, 
  run, 
  input_guardrail, 
  GuardrailFunctionOutput,
  RunContextWrapper,
  InputGuardrailTripwireTriggered 
} from '@openai/agents';

// Create a safety check for travel requests
const travelSafetyCheck = input_guardrail(
  async (
    ctx: RunContextWrapper<any>, 
    agent: Agent, 
    input: string
  ): Promise<GuardrailFunctionOutput> => {
    // Simple check for suspicious requests
    const suspiciousWords = ['free', 'hack', 'illegal', 'fake documents'];
    const isSuspicious = suspiciousWords.some(word => 
      input.toLowerCase().includes(word)
    );
    
    return {
      output_info: isSuspicious ? 'Blocked suspicious request' : 'Request approved',
      tripwire_triggered: isSuspicious, // Stops the agent if true
    };
  }
);

// Agent with safety guardrails
const safeAgent = new Agent({
  name: 'Safe Travel Agent',
  instructions: 'Help with legitimate travel planning only.',
  input_guardrails: [travelSafetyCheck], // Add the safety check
});

async function safeTravelPlanning() {
  try {
    const result = await run(
      safeAgent,
      'Help me plan a trip to Tokyo with proper documentation'
    );
    console.log('✅ Request approved:', result.finalOutput);
  } catch (error) {
    if (error instanceof InputGuardrailTripwireTriggered) {
      console.log('❌ Request blocked by safety check');
    }
  }
}

// What happens: Before processing any request, the safety check runs
// If suspicious content is detected, the agent stops immediately
safeTravelPlanning();
```

## 6. Streaming Implementation

**What it is:** Streaming is like getting real-time updates from your travel agent instead of waiting for them to finish everything before responding.

**File: `06-streaming-implementation.ts`**
```typescript
import { Agent, run } from '@openai/agents';

const itineraryAgent = new Agent({
  name: 'Itinerary Builder',
  instructions: 'Create detailed day-by-day travel itineraries with activities and timing.',
});

async function streamItinerary() {
  console.log('🏁 Starting itinerary planning...\n');
  
  // Enable streaming to get real-time responses
  const stream = await run(
    itineraryAgent,
    'Create a 3-day itinerary for Tokyo with must-see attractions',
    { stream: true } // This enables streaming
  );

  // Convert to text stream for easy reading
  const textStream = stream.toTextStream({ compatibleWithNodeStreams: true });
  
  // Show updates as they come in
  textStream.on('data', (chunk) => {
    process.stdout.write(chunk); // Print each piece as it arrives
  });
  
  // Wait for completion
  await stream.completed;
  console.log('\n\n✅ Itinerary complete!');
}

// Alternative: Handle raw events for more control
async function streamWithEvents() {
  const stream = await run(
    itineraryAgent,
    'Plan a romantic weekend in Paris',
    { stream: true }
  );

  // Process each event as it happens
  for await (const event of stream) {
    if (event.type === 'raw_model_stream_event') {
      // Handle model responses
      console.log('📝 Model response:', event.data);
    }
    if (event.type === 'agent_updated_stream_event') {
      // Handle agent changes  
      console.log('🤖 Agent changed to:', event.agent.name);
    }
  }
  
  await stream.completed;
}

// What happens: Instead of waiting for the complete itinerary,
// you see it being built piece by piece in real-time
streamItinerary();
```

## Getting Started

### Installation
```bash
npm install @openai/agents zod
```

### Environment Setup
```bash
export OPENAI_API_KEY=your_api_key_here
```

### Basic Usage Pattern
```typescript
import { Agent, run, tool } from '@openai/agents';
import { z } from 'zod';

// 1. Create tools (optional)
const myTool = tool({ /* tool definition */ });

// 2. Create agent  
const agent = new Agent({
  name: 'Agent Name',
  instructions: 'What the agent should do',
  tools: [myTool], // optional
});

// 3. Run agent
const result = await run(agent, 'User input here');
console.log(result.finalOutput);
```

## Key Concepts Summary

- **Agents**: AI assistants with specific roles and capabilities
- **Tools**: Functions that extend what agents can do beyond text
- **Handoffs**: Agents can transfer conversations to specialists  
- **Context**: Private data and state that tools can access
- **Guardrails**: Safety checks that prevent unwanted behavior
- **Streaming**: Real-time response delivery for better user experience

Each example demonstrates core functionality with travel-related use cases, showing how to build sophisticated AI assistants that can collaborate, use tools safely, and provide personalized, real-time service to travelers.








data: {"type":"delta","textDelta":"That","text":"{\"text\":\"That","city":null,"done":false}

data: {"type":"delta","textDelta":" sounds","text":"{\"text\":\"That sounds","city":null,"done":false}