// Optional second location source: Find My, via Photon's Advanced iMessage SDK
// (@photon-ai/advanced-imessage, Stable/Spectrum side, gRPC).
// https://photon.codes/docs/advanced-kits/imessage/locations
//
// - request(chat, address) sends a visible Find My request card; the person must accept.
// - watch() streams live updates for friends already sharing with Andi's line.
// - Missed updates during a disconnect are NOT replayed, so on reconnect we re-read list().
//
// Privacy: raw coordinates are never stored. We keep only "inside / outside" per risk place,
// in memory, and fire the same geofence events the iOS app sends.
//
// Needs a line address + bearer token for the Advanced SDK (FINDMY_IMESSAGE_ADDRESS / _TOKEN).
// Ask Photon whether your line (shared pool vs dedicated) exposes these.

import { createGrpcClient, type SharedFriendLocation } from "@photon-ai/advanced-imessage/grpc";
import { config, enabled } from "../config.js";
import { log } from "../log.js";
import { store } from "../store.js";
import { onPlaceEnter, onPlaceExit } from "../services/engine.js";

type Client = ReturnType<typeof createGrpcClient>;
let client: Client | null = null;
const inside = new Map<string, Set<string>>(); // personId -> placeIds currently inside

export const findMyEnabled = enabled.findmy;

function im() {
  if (!client) client = createGrpcClient({ address: config.findmy.address, token: config.findmy.token });
  return client;
}

const toRad = (d: number) => (d * Math.PI) / 180;
function metersBetween(aLat: number, aLng: number, bLat: number, bLng: number) {
  const R = 6_371_000;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function handleLocation(loc: SharedFriendLocation) {
  if (loc.latitude === undefined || loc.longitude === undefined) return; // docs: coords can be absent
  const p = store.linkedByPhone(loc.address);
  if (!p || !p.consents.location) return;

  const now = new Set(
    p.places
      .filter((pl) => metersBetween(loc.latitude!, loc.longitude!, pl.lat, pl.lng) <= pl.radiusM + (loc.accuracy ?? 0) / 2)
      .map((pl) => pl.id),
  );
  const before = inside.get(p.id) ?? new Set<string>();
  inside.set(p.id, now);
  for (const placeId of now) if (!before.has(placeId)) await onPlaceEnter(p.id, placeId);
  for (const placeId of before) if (!now.has(placeId)) await onPlaceExit(p.id, placeId);
}

// Ask the person to share their location with Andi's line (shows a Find My request card).
export async function requestFindMy(phone: string) {
  const { chat } = await im().chats.create([phone]);
  return im().locations.request(chat.guid, phone, { clientMessageId: `findmy-request:${phone}` });
}

export function startFindMyWatcher() {
  if (!findMyEnabled()) {
    log.info("findmy", "FINDMY_IMESSAGE_ADDRESS / FINDMY_IMESSAGE_TOKEN not set; using iOS geofences only");
    return;
  }
  let backoff = 1_000;
  const run = async () => {
    try {
      // Catch up on anything missed while disconnected, then stream.
      for (const loc of await im().locations.list()) await handleLocation(loc).catch((err) => log.error("findmy", "update failed", err));
      log.info("findmy", "watching shared locations");
      backoff = 1_000;
      for await (const update of im().locations.watch()) {
        await handleLocation(update.location).catch((err) => log.error("findmy", "update failed", err));
      }
    } catch (err) {
      log.warn("findmy", "stream ended; reconnecting", err);
    }
    setTimeout(run, backoff); // streams are not retried by the SDK
    backoff = Math.min(60_000, backoff * 2);
  };
  void run();
}
