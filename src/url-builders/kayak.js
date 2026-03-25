const airports = require("../data/airports.json");

function resolveAirport(cityName) {
  if (!cityName) return null;
  const key = cityName.trim().toLowerCase();
  if (airports[key]) return airports[key];
  if (/^[A-Z]{3}$/.test(cityName.trim())) return cityName.trim();
  return null;
}

function buildUrl({ origin, destination, date, returnDate, tripType }) {
  const depCode = resolveAirport(origin);
  const arrCode = resolveAirport(destination);

  if (!depCode) throw new Error(`Unknown origin airport: "${origin}"`);
  if (!arrCode) throw new Error(`Unknown destination airport: "${destination}"`);

  // Default date: tomorrow
  if (!date) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    date = tomorrow.toISOString().split("T")[0];
  }

  // Kayak date format: YYYY-MM-DD
  const isRoundTrip = tripType === "round-trip" || tripType === "Round trip";

  if (isRoundTrip) {
    if (!returnDate) {
      const ret = new Date(date);
      ret.setDate(ret.getDate() + 7);
      returnDate = ret.toISOString().split("T")[0];
    }
    return `https://www.kayak.co.in/flights/${depCode}-${arrCode}/${date}/${returnDate}?sort=price_a`;
  }

  return `https://www.kayak.co.in/flights/${depCode}-${arrCode}/${date}?sort=price_a`;
}

module.exports = { buildUrl, resolveAirport };
