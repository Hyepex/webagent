function buildUrl({ product }) {
  if (!product) throw new Error("Product query is required");
  const query = encodeURIComponent(product.trim());
  return `https://www.amazon.in/s?k=${query}&ref=nb_sb_noss`;
}

module.exports = { buildUrl };
