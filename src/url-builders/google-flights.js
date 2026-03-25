const path = require("path");
const airports = require("../data/airports.json");

// ─── Airport Lookup ──────────────────────────────────────────────────────────

function resolveAirport(cityName) {
  if (!cityName) return null;
  const key = cityName.trim().toLowerCase();
  // Direct lookup
  if (airports[key]) return airports[key];
  // If it looks like an IATA code already (3 uppercase letters), return as-is
  if (/^[A-Z]{3}$/.test(cityName.trim())) return cityName.trim();
  return null;
}

// ─── Protobuf Wire Format Encoding ──────────────────────────────────────────
// Wire type 2 = length-delimited (strings, embedded messages)

function encodeVarint(value) {
  const bytes = [];
  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value & 0x7f);
  return Buffer.from(bytes);
}

function encodeTag(fieldNumber, wireType) {
  return encodeVarint((fieldNumber << 3) | wireType);
}

function encodeLengthDelimited(fieldNumber, data) {
  const tag = encodeTag(fieldNumber, 2);
  const len = encodeVarint(data.length);
  return Buffer.concat([tag, len, data]);
}

function encodeString(fieldNumber, str) {
  return encodeLengthDelimited(fieldNumber, Buffer.from(str, "utf8"));
}

function encodeAirport(fieldNumber, iataCode) {
  // Airport message: field 2 = IATA code string
  const inner = encodeString(2, iataCode);
  return encodeLengthDelimited(fieldNumber, inner);
}

function encodeFlightInfo(date, depCode, arrCode) {
  // FlightInfo: field 2 = date, field 13 = dep_airport, field 14 = arr_airport
  const dateField = encodeString(2, date);
  const depField = encodeAirport(13, depCode);
  const arrField = encodeAirport(14, arrCode);
  return Buffer.concat([dateField, depField, arrField]);
}

// ─── URL Builder ─────────────────────────────────────────────────────────────

function buildUrl({ origin, destination, date, returnDate, tripType }) {
  const depCode = resolveAirport(origin);
  const arrCode = resolveAirport(destination);

  if (!depCode) throw new Error(`Unknown origin airport: "${origin}"`);
  if (!arrCode) throw new Error(`Unknown destination airport: "${destination}"`);

  // Default date: tomorrow if not provided
  if (!date) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    date = tomorrow.toISOString().split("T")[0];
  }

  // Encode outbound leg
  const outbound = encodeFlightInfo(date, depCode, arrCode);
  const legs = [encodeLengthDelimited(3, outbound)];

  // Encode return leg for round-trip
  const isRoundTrip = tripType === "round-trip" || tripType === "Round trip";
  if (isRoundTrip) {
    if (!returnDate) {
      // Default return: 7 days after departure
      const ret = new Date(date);
      ret.setDate(ret.getDate() + 7);
      returnDate = ret.toISOString().split("T")[0];
    }
    const inbound = encodeFlightInfo(returnDate, arrCode, depCode);
    legs.push(encodeLengthDelimited(3, inbound));
  }

  const root = Buffer.concat(legs);
  const tfs = root.toString("base64");

  return `https://www.google.com/travel/flights/search?tfs=${encodeURIComponent(tfs)}&curr=INR&hl=en`;
}

module.exports = { buildUrl, resolveAirport };
