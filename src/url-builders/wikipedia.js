function buildUrl({ topic }) {
  if (!topic) throw new Error("Topic is required");
  // Strip leading articles
  let cleaned = topic.trim().replace(/^(the|a|an)\s+/i, "");
  // Wikipedia title: capitalize first letter only, keep rest as-is
  cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  const slug = cleaned.replace(/\s+/g, "_");
  return `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(slug)}`;
}

module.exports = { buildUrl };
