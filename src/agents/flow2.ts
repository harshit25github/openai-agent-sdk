// Simplified Multi-Agent Travel Booking Flow Example
// This is a conceptual demonstration

// Simulated session storage
const sessions = new Map();

// Session state helper
function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, {
      destination: null,
      isDestinationValidated: false,
      dates: null,
      paxCount: null,
      itinerary: null,
      isItineraryFinalized: false,
      bookingDetails: null
    });
  }
  return sessions.get(chatId);
}

// Agent definitions (simplified)
const agents = {
  // 1. DESTINATION AGENT
  destination: {
    name: 'destination-agent',
    async process(request, session) {
      console.log('[Destination Agent] Processing:', request);
      
      // Simulate destination validation
      if (request.includes('validate')) {
        const destination = request.match(/validate (.+)/i)?.[1];
        if (destination) {
          // Mock validation logic
          session.destination = destination;
          session.isDestinationValidated = true;
          
          return {
            success: true,
            message: `✓ Destination "${destination}" validated! Safety checks passed. No visa required for short stays.`,
            data: { destination, safe: true, visaRequired: false }
          };
        }
      }
      
      return { 
        success: false, 
        message: 'Please provide a destination to validate' 
      };
    }
  },

  // 2. INSIGHT AGENT
  insight: {
    name: 'insight-agent',
    async process(request, session) {
      console.log('[Insight Agent] Processing:', request);
      
      if (!session.isDestinationValidated) {
        return {
          success: false,
          message: 'Destination must be validated first before providing insights'
        };
      }
      
      return {
        success: true,
        message: `Insights for ${session.destination}: Best time to visit is Spring/Fall. Must-see: Local markets and historic sites. Try local cuisine!`
      };
    }
  },

  // 3. ITINERARY AGENT
  itinerary: {
    name: 'itinerary-agent',
    async process(request, session) {
      console.log('[Itinerary Agent] Processing:', request);
      
      // Check if destination is validated
      if (!session.isDestinationValidated) {
        console.log('[Itinerary Agent] Destination not validated, checking with destination agent...');
        
        // Call destination agent for validation
        const destinationCheck = await agents.destination.process(
          `validate ${session.destination || 'unknown'}`, 
          session
        );
        
        if (!destinationCheck.success) {
          return {
            success: false,
            message: 'Cannot create itinerary: Destination validation failed. Please provide a valid destination first.'
          };
        }
      }
      
      // Create itinerary
      session.itinerary = {
        destination: session.destination,
        days: 3,
        activities: ['Day 1: City tour', 'Day 2: Museums', 'Day 3: Local experiences']
      };
      session.isItineraryFinalized = true;
      
      return {
        success: true,
        message: `✓ 3-day itinerary created for ${session.destination}!`,
        data: session.itinerary
      };
    }
  },

  // 4. BOOKING AGENT
  booking: {
    name: 'booking-agent',
    async process(request, session) {
      console.log('[Booking Agent] Processing:', request);
      
      // Check prerequisites
      if (!session.isDestinationValidated) {
        return {
          success: false,
          message: '❌ Cannot book: Destination not validated',
          redirect: 'destination'
        };
      }
      
      if (!session.isItineraryFinalized) {
        return {
          success: false,
          message: '❌ Cannot book: Itinerary not finalized',
          redirect: 'itinerary'
        };
      }
      
      // Simulate booking
      session.bookingDetails = {
        bookingId: 'BK' + Math.random().toString(36).substr(2, 9),
        status: 'confirmed'
      };
      
      return {
        success: true,
        message: `✓ Booking confirmed! ID: ${session.bookingDetails.bookingId}`,
        data: session.bookingDetails
      };
    }
  },

  // 5. GATEWAY AGENT (Main Orchestrator)
  gateway: {
    name: 'gateway-agent',
    async process(userMessage, chatId) {
      console.log('\n[Gateway Agent] User message:', userMessage);
      const session = getSession(chatId);
      
      // Intent classification (simplified)
      const intent = this.classifyIntent(userMessage);
      console.log('[Gateway Agent] Detected intent:', intent);
      
      let response;
      
      switch (intent) {
        case 'destination':
          response = await agents.destination.process(userMessage, session);
          break;
          
        case 'insights':
          response = await agents.insight.process(userMessage, session);
          break;
          
        case 'itinerary':
          response = await agents.itinerary.process(userMessage, session);
          break;
          
        case 'booking':
          response = await agents.booking.process(userMessage, session);
          
          // Handle redirects
          if (!response.success && response.redirect) {
            console.log(`[Gateway Agent] Redirecting to ${response.redirect} agent`);
            
            if (response.redirect === 'destination') {
              return 'I need to validate your destination first. Which city would you like to visit?';
            } else if (response.redirect === 'itinerary') {
              return 'You need an itinerary before booking. Would you like me to create one?';
            }
          }
          break;
          
        default:
          return 'I can help you plan and book travel. What destination are you interested in?';
      }
      
      return response.message;
    },
    
    classifyIntent(message) {
      const lower = message.toLowerCase();
      
      if (lower.includes('book') || lower.includes('reserve')) {
        return 'booking';
      } else if (lower.includes('itinerary') || lower.includes('plan')) {
        return 'itinerary';
      } else if (lower.includes('insight') || lower.includes('recommend')) {
        return 'insights';
      } else if (lower.includes('destination') || lower.includes('travel to') || lower.includes('validate')) {
        return 'destination';
      }
      
      return 'unknown';
    }
  }
};

// Example usage scenarios
async function demonstrateFlow() {
  const chatId = 'user-123';
  
  console.log('=== Multi-Agent Travel Booking Demo ===\n');
  
  // Scenario 1: User tries to book directly (will fail)
  console.log('--- Scenario 1: Direct booking attempt ---');
  let response = await agents.gateway.process(
    'I want to book a hotel in Paris',
    chatId
  );
  console.log('Response:', response);
  
  // Scenario 2: Proper flow - validate destination first
  console.log('\n--- Scenario 2: Validate destination ---');
  response = await agents.gateway.process(
    'I want to travel to Paris, validate Paris',
    chatId
  );
  console.log('Response:', response);
  
  // Scenario 3: Get insights
  console.log('\n--- Scenario 3: Get insights ---');
  response = await agents.gateway.process(
    'Give me insights about Paris',
    chatId
  );
  console.log('Response:', response);
  
  // Scenario 4: Create itinerary
  console.log('\n--- Scenario 4: Create itinerary ---');
  response = await agents.gateway.process(
    'Create an itinerary for my Paris trip',
    chatId
  );
  console.log('Response:', response);
  
  // Scenario 5: Now booking should work
  console.log('\n--- Scenario 5: Book the trip ---');
  response = await agents.gateway.process(
    'Book hotels and flights for my trip',
    chatId
  );
  console.log('Response:', response);
  
  // Show final state
  console.log('\n--- Final Session State ---');
  console.log(getSession(chatId));
}

// Alternative flow: Direct itinerary request (agent handles validation internally)
async function demonstrateAutoValidation() {
  const chatId = 'user-456';
  
  console.log('\n\n=== Auto-Validation Demo ===\n');
  
  // Set destination but don't validate
  const session = getSession(chatId);
  session.destination = 'Tokyo';
  
  console.log('--- Direct itinerary request (destination not validated) ---');
  const response = await agents.gateway.process(
    'Create an itinerary for my trip',
    chatId
  );
  console.log('Response:', response);
  
  console.log('\nSession after auto-validation:', getSession(chatId));
}

// Run demonstrations
async function main() {
  await demonstrateFlow();
  await demonstrateAutoValidation();
}

main().catch(console.error);