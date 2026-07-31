import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ISA_URL = "https://www.isa-agents.com.ar/info/line_up_mndrn.php?lang=en";
const OUTPUT_PATH = new URL("../data/positions.json", import.meta.url);
const OUTPUT_FILE = fileURLToPath(OUTPUT_PATH);
const RUN_DURATION_MS = Number(process.env.AIS_COLLECTION_MINUTES ?? 20) * 60_000;
const RETENTION_MS = 45 * 24 * 60 * 60 * 1_000;
const POSITION_TYPES = [
  "PositionReport",
  "StandardClassBPositionReport",
  "ExtendedClassBPositionReport",
];
const STATIC_TYPES = ["ShipStaticData", "StaticDataReport"];
const AIS_MESSAGE_TYPES = [...POSITION_TYPES, ...STATIC_TYPES];
const WORLD_BOX = [[[-90, -180], [90, 180]]];

function cleanCell(value) {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#039;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeName(value) {
  return String(value ?? "")
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9]/g, "");
}

function nameTokens(value) {
  return String(value ?? "")
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token && !["MV", "MT", "M", "V"].includes(token));
}

function editDistance(left, right) {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = row[0];
    row[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const previous = row[rightIndex];
      row[rightIndex] =
        left[leftIndex - 1] === right[rightIndex - 1]
          ? diagonal
          : Math.min(diagonal, row[rightIndex - 1], previous) + 1;
      diagonal = previous;
    }
  }
  return row[right.length];
}

function nameSimilarity(lineupName, aisName) {
  const lineup = normalizeName(lineupName);
  const ais = normalizeName(aisName);
  if (!lineup || !ais) return 0;
  if (lineup === ais) return 1;

  const lineupDigits = lineup.match(/\d+/g)?.join("") ?? "";
  const aisDigits = ais.match(/\d+/g)?.join("") ?? "";
  if (lineupDigits && aisDigits && lineupDigits !== aisDigits) return 0;

  const shorter = Math.min(lineup.length, ais.length);
  const longer = Math.max(lineup.length, ais.length);
  if (shorter >= 7 && (lineup.includes(ais) || ais.includes(lineup)) && shorter / longer >= 0.68) {
    return 0.94;
  }

  const editSimilarity = 1 - editDistance(lineup, ais) / Math.max(lineup.length, ais.length);
  const lineupSet = new Set(nameTokens(lineupName));
  const aisSet = new Set(nameTokens(aisName));
  const shared = [...lineupSet].filter((token) => aisSet.has(token)).length;
  const tokenSimilarity =
    Math.max(lineupSet.size, aisSet.size) > 1
      ? shared / Math.max(lineupSet.size, aisSet.size)
      : 0;
  return Math.max(editSimilarity, tokenSimilarity >= 0.67 ? 0.88 : 0);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

async function loadLineupNames() {
  const response = await fetch(ISA_URL, {
    headers: {
      accept: "text/html",
      "user-agent": "AgriFlow-AIS-Collector/1.0",
    },
  });
  if (!response.ok) throw new Error(`ISA returned HTTP ${response.status}`);
  const html = await response.text();
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((rowMatch) =>
      [...rowMatch[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) =>
        cleanCell(cell[1]),
      ),
    )
    .filter((cells) => cells.length === 14)
    .filter(
      (cells) =>
        cells[3] === "LOAD" &&
        ["GRAINS", "BY PRODUCTS", "VEGOIL"].includes(cells[4]),
    );
  const names = unique(rows.map((cells) => cells[2]));
  if (!names.length) throw new Error("No vessels were parsed from the ISA line-up");
  return names;
}

async function loadArchive() {
  try {
    return JSON.parse(await readFile(OUTPUT_PATH, "utf8"));
  } catch {
    return { generatedAt: null, collector: {}, vessels: [] };
  }
}

function bestNameMatch(names, aisName) {
  const ranked = names
    .map((name) => ({ name, score: nameSimilarity(name, aisName) }))
    .sort((left, right) => right.score - left.score);
  const best = ranked[0];
  const runnerUp = ranked[1];
  return best && best.score >= 0.84 && (!runnerUp || best.score - runnerUp.score >= 0.06)
    ? best.name
    : null;
}

function cleanAisText(value) {
  return String(value ?? "")
    .replace(/@+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function readMmsi(message) {
  const metadata = message?.MetaData ?? {};
  const body = message?.Message?.[message.MessageType] ?? {};
  const mmsi = String(
    metadata.MMSI_String ?? metadata.MMSI ?? body.UserID ?? "",
  );
  return /^\d{9}$/.test(mmsi) ? mmsi : null;
}

function readIdentity(message) {
  if (!STATIC_TYPES.includes(message?.MessageType)) return null;
  const metadata = message?.MetaData ?? {};
  const body = message?.Message?.[message.MessageType] ?? {};
  const mmsi = readMmsi(message);
  if (!mmsi) return null;

  const aisName = cleanAisText(
    body.Name ?? body.ReportA?.Name ?? metadata.ShipName,
  );
  const imoNumber = Number(body.ImoNumber);
  const shipType = Number(body.Type ?? body.ReportB?.ShipType);
  return {
    mmsi,
    aisName,
    imo:
      Number.isInteger(imoNumber) && imoNumber >= 1_000_000 && imoNumber <= 9_999_999
        ? String(imoNumber)
        : null,
    callsign: cleanAisText(body.CallSign ?? body.ReportB?.CallSign) || null,
    aisDestination: cleanAisText(body.Destination) || null,
    shipType: Number.isFinite(shipType) ? shipType : null,
    identityReportedAt: metadata.time_utc ?? new Date().toISOString(),
  };
}

function readPosition(message) {
  if (!POSITION_TYPES.includes(message?.MessageType)) return null;
  const metadata = message?.MetaData ?? {};
  const position = message?.Message?.[message.MessageType] ?? {};
  const mmsi = readMmsi(message);
  const latitude = Number(metadata.latitude ?? position.Latitude);
  const longitude = Number(metadata.longitude ?? position.Longitude);
  if (
    !mmsi ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return null;
  }
  const trueHeading = Number(position.TrueHeading);
  const course = Number(position.Cog);
  return {
    mmsi,
    aisName: cleanAisText(metadata.ShipName),
    latitude,
    longitude,
    speed: Number.isFinite(Number(position.Sog)) ? Number(position.Sog) : null,
    heading:
      Number.isFinite(trueHeading) && trueHeading >= 0 && trueHeading < 511
        ? trueHeading
        : Number.isFinite(course)
          ? course
          : null,
    course: Number.isFinite(course) ? course : null,
    reportedAt: metadata.time_utc ?? new Date().toISOString(),
  };
}

function listen(subscription, onMessage) {
  return new Promise((resolve) => {
    const socket = new WebSocket("wss://stream.aisstream.io/v0/stream");
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        socket.close(1000, "Collection complete");
      } catch {
        // The upstream may already be closed.
      }
      resolve();
    };
    const timer = setTimeout(finish, RUN_DURATION_MS);
    socket.addEventListener("open", () => socket.send(JSON.stringify(subscription)));
    socket.addEventListener("message", async (event) => {
      try {
        const raw =
          typeof event.data === "string"
            ? event.data
            : event.data instanceof Blob
              ? await event.data.text()
              : String(event.data);
        onMessage(JSON.parse(raw));
      } catch {
        // Ignore malformed upstream messages.
      }
    });
    socket.addEventListener("close", () => {
      clearTimeout(timer);
      finish();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      finish();
    });
  });
}

async function main() {
  const apiKey = process.env.AISSTREAM_API_KEY;
  if (!apiKey) throw new Error("AISSTREAM_API_KEY is not configured");

  const startedAt = new Date().toISOString();
  const [lineupNames, archive] = await Promise.all([loadLineupNames(), loadArchive()]);
  const now = Date.now();
  const byName = new Map();

  for (const vessel of archive.vessels ?? []) {
    const lastLineupSeen = Date.parse(vessel.lastLineupSeenAt ?? 0);
    if (Number.isFinite(lastLineupSeen) && now - lastLineupSeen <= RETENTION_MS) {
      byName.set(vessel.vesselName, vessel);
    }
  }
  for (const vesselName of lineupNames) {
    const existing = byName.get(vesselName) ?? { vesselName };
    byName.set(vesselName, {
      ...existing,
      vesselName,
      lastLineupSeenAt: startedAt,
    });
  }

  const trackedNames = [...byName.keys()];
  const byNormalizedName = new Map(
    trackedNames.map((vesselName) => [normalizeName(vesselName), vesselName]),
  );
  const namesByPrefix = new Map();
  for (const vesselName of trackedNames) {
    const prefix = normalizeName(vesselName).slice(0, 4);
    const candidates = namesByPrefix.get(prefix) ?? [];
    candidates.push(vesselName);
    namesByPrefix.set(prefix, candidates);
  }
  const byMmsi = new Map(
    [...byName.values()]
      .filter((vessel) => /^\d{9}$/.test(vessel.mmsi ?? ""))
      .map((vessel) => [vessel.mmsi, vessel.vesselName]),
  );
  const latestPositionByMmsi = new Map();
  let received = 0;
  let matched = 0;
  let identityMessages = 0;
  let identitiesLearned = 0;

  const resolveVesselName = (mmsi, aisName) => {
    const normalizedAisName = normalizeName(aisName);
    const fuzzyCandidates = namesByPrefix.get(normalizedAisName.slice(0, 4)) ?? [];
    return (
      byMmsi.get(mmsi) ??
      byNormalizedName.get(normalizedAisName) ??
      bestNameMatch(fuzzyCandidates, aisName)
    );
  };

  const applyPosition = (vesselName, position) => {
    const existing = byName.get(vesselName) ?? { vesselName };
    if (existing.mmsi && existing.mmsi !== position.mmsi) return false;
    const previousReport = Date.parse(existing.reportedAt ?? 0);
    const nextReport = Date.parse(position.reportedAt);
    if (Number.isFinite(previousReport) && Number.isFinite(nextReport) && previousReport > nextReport) {
      return false;
    }
    matched += 1;
    byMmsi.set(position.mmsi, vesselName);
    byName.set(vesselName, {
      ...existing,
      vesselName,
      aisName: position.aisName || existing.aisName || vesselName,
      mmsi: position.mmsi,
      latitude: position.latitude,
      longitude: position.longitude,
      speed: position.speed,
      heading: position.heading,
      course: position.course,
      reportedAt: position.reportedAt,
      receivedAt: new Date().toISOString(),
      source: "AISStream",
    });
    return true;
  };

  const applyIdentity = (identity) => {
    const vesselName = resolveVesselName(identity.mmsi, identity.aisName);
    if (!vesselName) return null;
    const existing = byName.get(vesselName) ?? { vesselName };
    if (existing.mmsi && existing.mmsi !== identity.mmsi) return null;
    const isNewIdentity = existing.mmsi !== identity.mmsi;
    byMmsi.set(identity.mmsi, vesselName);
    byName.set(vesselName, {
      ...existing,
      vesselName,
      aisName: identity.aisName || existing.aisName || vesselName,
      mmsi: identity.mmsi,
      imo: identity.imo || existing.imo || null,
      callsign: identity.callsign || existing.callsign || null,
      aisDestination: identity.aisDestination || existing.aisDestination || null,
      shipType: identity.shipType ?? existing.shipType ?? null,
      identityReportedAt: identity.identityReportedAt,
      identitySource: "AISStream static data",
    });
    if (isNewIdentity) identitiesLearned += 1;
    const pendingPosition = latestPositionByMmsi.get(identity.mmsi);
    if (pendingPosition) applyPosition(vesselName, pendingPosition);
    return vesselName;
  };

  const onMessage = (message) => {
    received += 1;
    const identity = readIdentity(message);
    if (identity) {
      identityMessages += 1;
      applyIdentity(identity);
    }
    const position = readPosition(message);
    if (!position) return;
    latestPositionByMmsi.set(position.mmsi, position);
    const vesselName = resolveVesselName(position.mmsi, position.aisName);
    if (vesselName) applyPosition(vesselName, position);
  };

  const baseSubscription = {
    APIKey: apiKey,
    FilterMessageTypes: AIS_MESSAGE_TYPES,
  };
  await listen({ ...baseSubscription, BoundingBoxes: WORLD_BOX }, onMessage);

  const output = {
    generatedAt: new Date().toISOString(),
    collector: {
      startedAt,
      durationMinutes: Math.round(RUN_DURATION_MS / 60_000),
      lineupVessels: lineupNames.length,
      trackedVessels: byName.size,
      messagesReceived: received,
      matchedMessages: matched,
      staticIdentityMessages: identityMessages,
      identitiesLearned,
      identifiedVessels: [...byName.values()].filter((vessel) => vessel.mmsi).length,
      note:
        "Positions are verified global AIS reports. Missing vessels are not estimated.",
    },
    vessels: [...byName.values()].sort((left, right) =>
      left.vesselName.localeCompare(right.vesselName),
    ),
  };
  await mkdir(dirname(OUTPUT_FILE), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(
    `Saved ${output.vessels.filter((vessel) => vessel.reportedAt).length} verified positions for ${output.vessels.length} tracked vessels.`,
  );
}

await main();
