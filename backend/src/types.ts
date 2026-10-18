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
    | "voice_note"
    | "inbound"
    | "coping"; // a coping activity they mentioned (detail = "walk", "meeting", ...; never their words)
  detail?: string;
  level?: RiskLevel;
}

export interface Purchase {
  at: string;
  merchant: string;
  amount: number;
  txId?: string; // Nessie transaction id, so the demo route and the webhook never count one purchase twice
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

// Local hours (0-23) when Andi holds back proactive texts. end is exclusive; start > end wraps midnight.
export interface QuietHours {
  enabled: boolean;
  start: number;
  end: number;
}

export interface Person {
  id: string;
  name: string;
  phone: string; // normalized iMessage handle (E.164 or email)
  enteredPhone?: string; // what they typed at onboarding (normalized); phone may become an email handle on link
  soberSince: string; // YYYY-MM-DD
  timezone?: string; // IANA zone from the phone (e.g. "America/Chicago"); day counts and quiet hours use it
  quietHours?: QuietHours; // set in the app; unset means the server default (QUIET_START_HOUR..QUIET_END_HOUR)
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
  // "Andi learns you": the latest pattern summary from their own history (src/risk/patterns.ts).
  patterns?: LearnedPatterns;
  lastPatternNudgeAt?: string;
}

export interface LearnedPatterns {
  ready: boolean;
  riskyWindow: { weekday: number | null; startHour: number; hours: number } | null;
  topTrigger: "hungry" | "angry" | "lonely" | "tired" | "places" | null;
  whatHelped: "walk" | "breathe" | "call" | "meeting" | "talk" | "workout" | "music" | null;
  confidence: number; // 0-100
  source: "chalk" | "local";
  at: string;
}

// A sign-in started on the app's first screen. Starting one never says whether the number has an
// account: only a text from that number decides. It becomes a sign-in (the account takes over
// `token`) or a verified new signup that /api/onboard turns into a person.
export interface SignIn {
  id: string;
  phone: string; // normalized; becomes the sender's handle once verified (it can be an iMessage email)
  enteredPhone: string; // what they typed (normalized)
  token: string; // the install's token: the account's apiToken after sign-in or signup
  code: string; // 6 digits, texted as "hi andi <code>"
  createdAt: string;
  verifiedAt?: string; // set when the code arrives from this number and there's no account for it
  photon: PhotonLink; // the line assignment at start; the conversation once verified
}

export interface StoreData {
  version: 2;
  people: Record<string, Person>;
  signIns?: Record<string, SignIn>;
  photonCursor: number;
  unknownReplies?: Record<string, string>; // handle -> last auto-reply time
  nessieWebhook?: { id: string; url: string; secret: string }; // our notify hook (the secret is only shown once)
  nessieSeen?: string[]; // recent Nessie-Event-Ids, for at-least-once delivery
}
