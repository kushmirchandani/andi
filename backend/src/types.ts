export type RiskLevel = "low" | "elevated" | "high";

export type ShareLevel = "none" | "status" | "status_and_reason";

export interface Consents {
  location: boolean; // iOS geofences / Find My around risk places
  purchases: boolean; // Nessie purchase signals
  shareWithSponsor: ShareLevel; // what the sponsor's status message shows
  sponsorAlerts: boolean; // may Andi text the sponsor on high-risk nights
}

export interface RiskPlace {
  id: string;
  name: string;
  lat: number;
  lng: number;
  radiusM: number;
  kind: "bar" | "liquor_store" | "other";
  alternative?: string; // a safe option nearby, shown in the "do you want to be here?" text
}

export interface CheckIn {
  at: string;
  hungry: boolean;
  angry: boolean;
  lonely: boolean;
  tired: boolean;
  mood?: number; // 1-5
  note?: string;
  source: "app" | "imessage" | "chip";
}

export interface Screening {
  drinksPerDay: number;
  drinksDaily: boolean;
  morningDrinking: boolean;
  pastWithdrawal: boolean; // shakes, sweats, seizures or hallucinations when stopping
  medicalFirst: boolean;
}

export interface PhotonLink {
  spaceId?: string;
  agentUserId?: string; // receivedBy.id on their inbound messages; we send as this user
  userId?: string;
  lastInboundAt?: string;
  lastOutboundAt?: string;
  lastReadAt?: string;
  lastCheckinPollId?: string;
  assignmentId?: string; // Photon shared-line assignment for this handle
  andiNumber?: string; // the number this handle texts (the assignment's assignedPhoneNumber)
}

export interface Sponsor {
  name: string;
  phone: string; // E.164 or iMessage email
  portalToken: string;
  photon: PhotonLink & { statusMessageId?: string; statusText?: string };
  lastAlertAt?: string;
}

export interface AndiEvent {
  at: string;
  kind:
    | "onboarded"
    | "linked"
    | "restored"
    | "place_enter"
    | "place_exit"
    | "purchase"
    | "checkin"
    | "risk_change"
    | "outreach"
    | "sponsor_alert"
    | "call"
    | "breathe"
    | "slip"
    | "crisis"
    | "milestone"
    | "inbound";
  detail?: string;
  level?: RiskLevel;
}

export interface Purchase {
  at: string;
  merchant: string;
  amount: number;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface Person {
  id: string;
  name: string;
  phone: string; // normalized iMessage handle (E.164 or email)
  enteredPhone?: string; // what they typed at onboarding (normalized); phone may become an email handle on link
  soberSince: string; // YYYY-MM-DD
  timezone?: string; // IANA zone from the phone (e.g. "America/Chicago"); day counts and quiet hours use it
  createdAt: string;
  apiToken: string;
  linkCode?: string; // 6 digits; texting "hi andi <code>" links (and verifies) their iMessage handle
  screening: Screening;
  consents: Consents;
  places: RiskPlace[];
  checkins: CheckIn[];
  slips: { at: string; note?: string }[];
  events: AndiEvent[];
  purchases: Purchase[]; // alcohol-seller purchases (consented)
  chat: ChatTurn[]; // last few turns with Andi, for conversational continuity across restarts
  sponsor?: Sponsor;
  photon: PhotonLink;
  weeklyDrinkSpend: number; // self-reported baseline for "money saved"
  nessie?: { customerId?: string; accountId?: string };
  lastAlcoholPurchase?: Purchase;
  lastPlaceEnter?: { at: string; placeId: string };
  lastRisk?: { level: RiskLevel; score: number; reasons: string[]; source: string; at: string };
  lastOutreachAt?: string;
  lastCallAt?: string;
  chipToken?: string;
  chipPendingToken?: string; // issued by /api/chip/pair, promoted when the chip first connects with it
  whyText?: string;
  whyAudioPath?: string;
}

export interface StoreData {
  version: 2;
  people: Record<string, Person>;
  photonCursor: number;
  unknownReplies?: Record<string, string>; // handle -> last auto-reply time
}
