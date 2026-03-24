const Template = require("../models/Template");
const { createLogger } = require("../utils/logger");

const log = createLogger("seeds");

const SEED_TEMPLATES = [
  {
    name: "Price Search",
    category: "shopping",
    icon: "\u{1F6D2}",
    description: "Find the best price for any product on a specific store",
    instruction_template: "Find the cheapest {{product}} on {{website}}",
    variables: [
      { name: "product", label: "Product", type: "text", placeholder: "iPhone 15, PlayStation 5, etc." },
      { name: "website", label: "Website", type: "select", options: ["Amazon India", "Flipkart", "Amazon.com"], required: true },
    ],
  },
  {
    name: "News Headlines",
    category: "news",
    icon: "\u{1F4F0}",
    description: "Get today's top headlines from a news source",
    instruction_template: "Get today's top headlines from {{source}}",
    variables: [
      { name: "source", label: "News Source", type: "select", options: ["BBC News", "CNN", "Reuters", "Times of India", "NDTV"] },
    ],
  },
  {
    name: "Wikipedia Lookup",
    category: "research",
    icon: "\u{1F4DA}",
    description: "Research any topic on Wikipedia",
    instruction_template: "Go to Wikipedia and find information about {{topic}}",
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
    description: "Check current weather for any city",
    instruction_template: "Go to weather.com and find the current weather in {{city}}",
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
    instruction_template: "Search for flights from {{origin}} to {{destination}} on Google Flights",
    variables: [
      { name: "origin", label: "From", type: "text", placeholder: "Mumbai" },
      { name: "destination", label: "To", type: "text", placeholder: "Dubai" },
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
