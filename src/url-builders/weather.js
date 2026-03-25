function buildUrl({ city }) {
  if (!city) throw new Error("City is required");
  const encoded = encodeURIComponent(city.trim());
  return `https://wttr.in/${encoded}?format=j1`;
}

module.exports = { buildUrl };
