/**
 * Travel AI Agent System Type Definitions
 * Contains all TypeScript interfaces and types for the multi-agent system
 */

import { z } from 'zod';

// ============= User Profile Types =============

export type TravelStyle = 'budget' | 'mid-range' | 'luxury' | 'backpacker';
export type FlightClass = 'economy' | 'premium' | 'business' | 'first';
export type SeatPreference = 'aisle' | 'window' | 'no_preference';
export type AccommodationType = 'hotel' | 'boutique' | 'hostel' | 'airbnb' | 'resort';
export type LocationPreference = 'city_center' | 'quiet' | 'near_transit' | 'beachfront';
export type TravelPace = 'relaxed' | 'moderate' | 'active' | 'packed';
export type EmotionalTone = 'excited' | 'anxious' | 'practical' | 'undecided';
export type ConversationStage = 'discovery' | 'planning' | 'booking' | 'support';

export interface FlightPreferences {
  class: FlightClass;
  airlines: string[];
  avoidAirlines: string[];
  seatType: SeatPreference;
  maxStops: number;
  timeOfDay?: 'morning' | 'afternoon' | 'evening' | 'red-eye';
}

export interface HotelPreferences {
  type: AccommodationType;
  amenities: string[];
  roomType: string;
  location: LocationPreference;
  chains: string[];
}

export interface UserPreferences {
  travelStyle: TravelStyle;
  interests: string[];
  dietaryRestrictions: string[];
  accessibilityNeeds: string[];
  languagesSpoken: string[];
  flightPreferences: FlightPreferences;
  hotelPreferences: HotelPreferences;
  travelPace: TravelPace;
  mustDoActivities?: string[];
  timeOfDayPreference?: 'morning_person' | 'night_owl' | 'flexible';
  scheduleFlexibility?: 'rigid' | 'moderate' | 'flexible';
  mobilityLevel?: 'full' | 'moderate' | 'limited';
  restNeeds?: 'minimal' | 'regular' | 'frequent';
  mealSchedule?: 'regular' | 'flexible' | 'grazing';
  excludedDestinations?: string[];
}

export interface LoyaltyPrograms {
  airlines: Record<string, string>;
  hotels: Record<string, string>;
}

export interface TravelHistoryItem {
  destination: string;
  date: string;
  rating: number;
  type: string;
  highlights?: string[];
  issues?: string[];
}

export interface UserProfile {
  id: string;
  email?: string;
  name?: string;
  preferences: UserPreferences;
  loyaltyPrograms: LoyaltyPrograms;
  travelHistory: TravelHistoryItem[];
  createdAt: Date;
  updatedAt: Date;
}

// ============= Trip Planning Types =============

export interface TravelerGroup {
  adults: number;
  children: number[];
  infants?: number;
  seniors?: number;
}

export interface TripBudget {
  total: number;
  currency: string;
  allocated: {
    flights?: number;
    accommodation?: number;
    activities?: number;
    food?: number;
    transportation?: number;
    shopping?: number;
  };
}

export interface BookedItem {
  type: 'flight' | 'hotel' | 'activity' | 'transportation';
  details: any;
  confirmationNumber?: string;
  price: number;
  currency: string;
  bookingDate: Date;
  cancellationPolicy?: string;
}

export interface ActiveTrip {
  id?: string;
  purpose: string;
  destinations: string[];
  dates: {
    start: Date;
    end: Date;
  };
  travelers: TravelerGroup;
  budget: TripBudget;
  constraints: string[];
  bookedItems: BookedItem[];
  status: 'planning' | 'partially_booked' | 'fully_booked' | 'completed';
}

// ============= Conversation Memory Types =============

export interface UserCorrection {
  original: string;
  corrected: string;
  topic: string;
  timestamp: Date;
}

export interface ConversationMemory {
  recentTopics: string[];
  clarifiedPoints: Record<string, string>;
  userCorrections: UserCorrection[];
  emotionalTone: EmotionalTone;
  importantNotes: string[];
}

// ============= Session Types =============

export interface CurrentSession {
  sessionId: string;
  userId: string;
  startTime: Date;
  lastInteraction: Date;
  conversationStage: ConversationStage;
  activeTrip: ActiveTrip;
  mentionedPreferences: Record<string, any>;
  rejectedOptions: string[];
  agentInteractions: AgentInteraction[];
}

export interface AgentInteraction {
  agentName: string;
  timestamp: Date;
  input: string;
  output: string;
  toolsUsed?: string[];
  handoffTo?: string;
}

// ============= Complete Context Type =============

export interface TravelAgentContext {
  userProfile: UserProfile;
  currentSession: CurrentSession;
  conversationMemory: ConversationMemory;
}

// ============= Agent Response Types =============

export interface AgentResponse {
  content: string;
  metadata?: {
    confidence?: number;
    sources?: string[];
    suggestedFollowUp?: string[];
  };
  handoffTo?: string;
  updateContext?: Partial<TravelAgentContext>;
}

// ============= Tool Parameter Schemas =============

export const FlightSearchSchema = z.object({
  origin: z.string().describe('Departure city or airport code'),
  destination: z.string().describe('Arrival city or airport code'),
  departureDate: z.string().describe('Departure date (YYYY-MM-DD)'),
  returnDate: z.string().optional().nullable().describe('Return date for round trips'),
  passengers: z.object({
    adults: z.number().default(1),
    children: z.array(z.number()).default([]),
    infants: z.number().default(0)
  }),
  preferences: z.object({
    class: z.enum(['economy', 'premium', 'business', 'first']).optional().nullable(),
    maxStops: z.number().max(2).optional().nullable(),
    airlines: z.array(z.string()).optional().nullable(),
    timeOfDay: z.enum(['morning', 'afternoon', 'evening', 'red-eye']).optional().nullable()
  }).optional().nullable()
});

export const HotelSearchSchema = z.object({
  location: z.string().describe('City, address, or landmark'),
  checkIn: z.string().describe('Check-in date (YYYY-MM-DD)'),
  checkOut: z.string().describe('Check-out date (YYYY-MM-DD)'),
  guests: z.object({
    adults: z.number().min(1),
    children: z.array(z.number()).default([])
  }),
  preferences: z.object({
    priceRange: z.object({
      min: z.number().optional().nullable(),
      max: z.number().optional().nullable()
    }).optional().nullable(),
    starRating: z.number().min(1).max(5).optional().nullable(),
    amenities: z.array(z.string()).optional().nullable(),
    propertyType: z.enum(['hotel', 'apartment', 'resort', 'hostel']).optional().nullable()
  }).optional().nullable()
});

export const DestinationInfoSchema = z.object({
  destination: z.string(),
  travelDates: z.object({
    start: z.string(),
    end: z.string()
  }).optional().nullable(),
  interests: z.array(z.string()).optional().nullable(),
  infoTypes: z.array(z.enum([
    'weather', 'events', 'attractions', 'restaurants', 
    'transportation', 'safety', 'culture'
  ])).optional().nullable()
});

// ============= Memory Storage Types =============

export interface ConversationTurn {
  id: string;
  sessionId: string;
  userId: string;
  timestamp: Date;
  role: 'user' | 'assistant' | 'system';
  content: string;
  agentName?: string;
  metadata?: Record<string, any>;
}

export interface SessionSummary {
  sessionId: string;
  userId: string;
  startTime: Date;
  endTime?: Date;
  tripPlanned?: ActiveTrip;
  keyDecisions: string[];
  nextSteps?: string[];
}

// ============= Agent Configuration Types =============

export interface AgentConfig {
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  handoffAgents?: string[];
  maxTokens?: number;
  temperature?: number;
  model?: string;
}

// ============= Error Types =============

export class TravelAgentError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: any
  ) {
    super(message);
    this.name = 'TravelAgentError';
  }
}

export enum ErrorCodes {
  AGENT_NOT_FOUND = 'AGENT_NOT_FOUND',
  TOOL_EXECUTION_FAILED = 'TOOL_EXECUTION_FAILED',
  CONTEXT_UPDATE_FAILED = 'CONTEXT_UPDATE_FAILED',
  SESSION_NOT_FOUND = 'SESSION_NOT_FOUND',
  INVALID_HANDOFF = 'INVALID_HANDOFF',
  API_RATE_LIMIT = 'API_RATE_LIMIT',
  EXTERNAL_API_ERROR = 'EXTERNAL_API_ERROR'
}

// ============= Utility Types =============

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export type AgentName = 
  | 'orchestrator'
  | 'trip_planner'
  | 'flight_specialist'
  | 'hotel_specialist'
  | 'local_expert'
  | 'itinerary_optimizer';

export interface ToolResult<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  metadata?: Record<string, any>;
}