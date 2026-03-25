const Template = require("../models/Template");
const { createLogger } = require("../utils/logger");

const log = createLogger("seeds");

const SEED_TEMPLATES = [
  {
    name: "Price Search",
    category: "shopping",
    icon: "\u{1F6D2}",
    recipe_id: "amazon_in_price_search",
    description: "Find the best price for any product on Amazon India",
    instruction_template: "Find the cheapest {{product}} on Amazon",
    variables: [
      { name: "product", label: "Product", type: "text", placeholder: "iPhone 15, PlayStation 5, etc." },
    ],
  },
  {
    name: "News Headlines",
    category: "news",
    icon: "\u{1F4F0}",
    recipe_id: "bbc_news_headlines",
    description: "Get today's top headlines from BBC News",
    instruction_template: "Get today's top headlines from BBC News",
    variables: [],
  },
  {
    name: "Wikipedia Lookup",
    category: "research",
    icon: "\u{1F4DA}",
    recipe_id: "wikipedia_lookup",
    description: "Research any topic on Wikipedia",
    instruction_template: "Search Wikipedia for {{topic}}",
    variables: [
      { name: "topic", label: "Topic", type: "text", placeholder: "Eiffel Tower, quantum physics, etc." },
    ],
  },
  {
    name: "Product Comparison",
    category: "shopping",
    icon: "\u2696\uFE0F",
    description: "Compare prices for a product across multiple stores",
    instruction_template: "Compare prices for {{product}} on Amazon India and Flipkart and tell me which is cheaper",
    variables: [
      { name: "product", label: "Product", type: "text", placeholder: "Samsung Galaxy S24, MacBook Air, etc." },
    ],
  },
  {
    name: "Weather Check",
    category: "utilities",
    icon: "\u{1F324}\uFE0F",
    recipe_id: "weather_check",
    description: "Check current weather for any city",
    instruction_template: "What is the weather in {{city}}",
    variables: [
      { name: "city", label: "City", type: "text", placeholder: "Mumbai, New York, Tokyo, etc." },
    ],
  },
  {
    name: "Page Monitor",
    category: "monitoring",
    icon: "\u{1F441}\uFE0F",
    description: "Check a webpage and report its current content",
    instruction_template: "Go to {{url}} and tell me what the main content says",
    variables: [
      { name: "url", label: "Website URL", type: "url", placeholder: "https://example.com" },
    ],
  },
  {
    name: "Flight Search",
    category: "travel",
    icon: "\u2708\uFE0F",
    description: "Search for flights between two cities",
    instruction_template: "Search for {{trip_type}} flights from {{origin}} to {{destination}} on {{date}}",
    variables: [
      { name: "origin", label: "From", type: "text", placeholder: "Mumbai, Dubai, etc." },
      { name: "destination", label: "To", type: "text", placeholder: "Goa, London, etc." },
      { name: "date", label: "Departure date", type: "text", placeholder: "2026-04-15 or leave empty for tomorrow" },
      { name: "trip_type", label: "Trip type", type: "select", options: ["One way", "Round trip"] },
    ],
  },
  {
    name: "Job Search",
    category: "research",
    icon: "\u{1F4BC}",
    description: "Find job listings on a job board",
    instruction_template: "Search for {{job_title}} jobs in {{location}} on LinkedIn",
    variables: [
      { name: "job_title", label: "Job Title", type: "text", placeholder: "Software Engineer" },
      { name: "location", label: "Location", type: "text", placeholder: "Mumbai, Remote, etc." },
    ],
  },
];

async function seedTemplates() {
  try {
    const count = await Template.countDocuments();
    if (count > 0) {
      log.info(`Templates already seeded (${count} found)`);
      return;
    }

    await Template.insertMany(SEED_TEMPLATES);
    log.success(`Seeded ${SEED_TEMPLATES.length} task templates`);
  } catch (err) {
    log.warn(`Template seeding failed: ${err.message}`);
  }
}

module.exports = { seedTemplates };
